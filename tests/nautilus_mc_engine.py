"""
Nautilus Market Simulator — Standalone
========================================
Who wins and who loses?を見るsim。
エンジンコードを内包したスタンドアロン版。
"""

from __future__ import annotations

"""
Nautilus Monte Carlo Engine
============================
Source of truth: programs/nautilus/src/lib.rs

Protocol-faithful simulator with a convenience stop condition.
lib.rsの挙動を正確に再現するエンジン。

重要な設計判断:
  - engine本体はlib.rsと同じrejectを行う
  - policy側でclamp_to_remaining=True/Falseを切り替え可能
    True  → UI/普通ユーザー向け（残量にclamp）
    False → 生のprotocol interaction向け（rejectのまま）
  - AllStagesCompleteは convenience stop condition（lib.rsにはない）

Stage番号の表記:
  - idx: コード内のcurrent_stage（0-indexed）
  - human: 人間が言うStage番号（1-indexed）
  - human = idx + 1
"""


from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
import math
import random
from typing import Callable, Dict, List, Optional, Tuple


# ============================================================
# 定数 — lib.rsと完全一致
# ============================================================

FIB: List[int] = [
    1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
    89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765,
]

STAGE_SUPPLY: List[int] = [
    1_000_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000,
    8_000_000, 13_000_000, 21_000_000, 34_000_000, 55_000_000,
    89_000_000, 144_000_000, 233_000_000, 377_000_000, 610_000_000,
    987_000_000, 1_597_000_000, 2_584_000_000, 4_181_000_000, 6_765_000_000,
]

BASE_PRICE_LAMPORTS: int = 1_000_000
SPREAD_BPS: int = 50
MAX_AMOUNT_PER_TX: int = 1_000_000
DEFAULT_RENT_MINIMUM: int = 890_880
SOL: int = 1_000_000_000


def human_stage(idx: int) -> int:
    """idx(0-indexed) → human Stage番号(1-indexed)"""
    return idx + 1


# ============================================================
# データ構造
# ============================================================

class TxKind(str, Enum):
    BUY  = "buy"
    SELL = "sell"
    HOLD = "hold"


@dataclass
class Wallet:
    wallet_id: int
    sol: int
    tokens: int = 0

    total_buy_cost:    int = 0
    total_sell_payout: int = 0
    successful_buys:   int = 0
    successful_sells:  int = 0
    failed_buys:       int = 0
    failed_sells:      int = 0

    def pnl(self) -> int:
        return self.total_sell_payout - self.total_buy_cost

    def pnl_pct(self) -> float:
        if self.total_buy_cost == 0:
            return 0.0
        return self.pnl() / self.total_buy_cost * 100

    def mark_to_market(self, sell_price: int) -> int:
        """未売却トークンの時価を含む総資産（lamports）"""
        return self.sol + self.tokens * sell_price


@dataclass
class NautilusState:
    treasury_balance:         int = 0
    total_sold:               int = 0
    current_stage:            int = 0
    stage_sold: List[int]         = field(default_factory=lambda: [0] * len(STAGE_SUPPLY))
    treasury_actual_lamports: int = 0


@dataclass
class TxResult:
    kind:             TxKind
    wallet_id:        int
    requested_amount: int
    executed_amount:  int
    success:          bool
    reason:           str

    stage_before:      int
    stage_after:       int
    buy_price_before:  int
    sell_price_before: int
    treasury_before:   int
    total_sold_before: int

    cost_paid:        int = 0
    payout_received:  int = 0
    spread_paid:      int = 0


@dataclass
class StageTransitionSnapshot:
    """ステージが進んだ瞬間の状態"""
    stage_idx_before:    int
    stage_idx_after:     int
    treasury:            int
    total_sold:          int
    sell_price_before:   int    # 進行直前のsell_price
    new_buy_price:       int    # 進行後の新しいbuy_price
    immediate_downside:  float  # 1 - 0.995 * sell_price / new_buy_price（downside %）
    trigger_actor:       str    # "organic" / "bot" / "whale" / "unknown"

    @property
    def human_before(self) -> int:
        return human_stage(self.stage_idx_before)

    @property
    def human_after(self) -> int:
        return human_stage(self.stage_idx_after)


@dataclass
class RunStats:
    total_steps:              int = 0
    buy_attempts:             int = 0
    buy_successes:            int = 0
    sell_attempts:            int = 0
    sell_successes:           int = 0
    stage_advances:           int = 0
    total_buy_volume_tokens:  int = 0
    total_sell_volume_tokens: int = 0
    total_buy_volume_sol:     int = 0
    total_sell_payout_sol:    int = 0
    total_spread_sol:         int = 0
    invariant_violations:     int = 0
    stage_transitions:        List[StageTransitionSnapshot] = field(default_factory=list)
    # stage別actor内訳: stage_actor_buys[stage_idx][actor] = 累計買い枚数
    stage_actor_buys:         Dict = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    # bot損失追跡
    bot_total_cost:           int = 0
    bot_total_payout:         int = 0
    bot_triggered_advances:   int = 0


# ============================================================
# コアエンジン — lib.rsの正確なミラー
# ============================================================

class NautilusEngine:
    """
    Protocol-faithful simulator with a convenience stop condition.

    lib.rsとの対応:
      - buy() はstage capで reject（partial fillなし）
      - sell() はstage_soldを減らさない
      - ステージ進行はbuy時にtrancheが埋まった時だけ
      - sell_price = accounted treasury_balance // total_sold
      - AllStagesComplete はconvenience stop（lib.rsにはない概念）
    """

    def __init__(self, rent_minimum: int = DEFAULT_RENT_MINIMUM):
        self.state          = NautilusState()
        self.rent_minimum   = rent_minimum
        self.history:       List[TxResult] = []
        self.stats          = RunStats()
        self._current_actor = "unknown"  # policy側からセットする

    # ── read-only helpers ──────────────────────────────────

    def buy_price(self) -> int:
        s = self.state.current_stage
        if s >= len(FIB):
            return 0
        return BASE_PRICE_LAMPORTS * FIB[s]

    def sell_price(self) -> int:
        if self.state.total_sold == 0:
            return 0
        return self.state.treasury_balance // self.state.total_sold

    def remaining_in_stage(self) -> int:
        s = self.state.current_stage
        if s >= len(STAGE_SUPPLY):
            return 0
        return STAGE_SUPPLY[s] - self.state.stage_sold[s]

    def is_finished(self) -> bool:
        """最終trancheを売り切った時にTrue（convenience stop condition）"""
        last = len(STAGE_SUPPLY) - 1
        return (
            self.state.current_stage == last
            and self.state.stage_sold[last] >= STAGE_SUPPLY[last]
        )

    def snapshot(self) -> Dict:
        s = self.state
        return {
            "stage_idx":          s.current_stage,
            "stage_human":        human_stage(s.current_stage),
            "buy_price_sol":      self.buy_price() / SOL,
            "sell_price_sol":     self.sell_price() / SOL,
            "treasury_sol":       s.treasury_balance / SOL,
            "total_sold":         s.total_sold,
            "remaining_in_stage": self.remaining_in_stage(),
        }

    # ── invariant checker ─────────────────────────────────

    def check_invariants(self, result: TxResult) -> None:
        s  = self.state
        ok = True

        if s.treasury_balance < 0:
            print(f"  [INVARIANT VIOLATION] treasury_balance < 0: {s.treasury_balance}")
            ok = False

        if s.total_sold < 0:
            print(f"  [INVARIANT VIOLATION] total_sold < 0: {s.total_sold}")
            ok = False

        if result.stage_after < result.stage_before:
            print(f"  [INVARIANT VIOLATION] stage decreased: "
                  f"Stage {human_stage(result.stage_before)} → Stage {human_stage(result.stage_after)}")
            ok = False

        # sell成功後にsell_priceが下がっていないか（total_sold > 0の場合のみ）
        if result.kind == TxKind.SELL and result.success and s.total_sold > 0:
            sp_after = self.sell_price()
            if sp_after < result.sell_price_before:
                print(f"  [INVARIANT VIOLATION] sell_price decreased after sell: "
                      f"{result.sell_price_before} → {sp_after}")
                ok = False

        if not ok:
            self.stats.invariant_violations += 1

    # ── core: buy ─────────────────────────────────────────

    def buy(self, wallet: Wallet, amount: int) -> TxResult:
        self.stats.buy_attempts += 1

        stage_before      = self.state.current_stage
        buy_price_before  = self.buy_price()
        sell_price_before = self.sell_price()
        treasury_before   = self.state.treasury_balance
        total_sold_before = self.state.total_sold

        def fail(reason: str) -> TxResult:
            wallet.failed_buys += 1
            r = TxResult(
                kind=TxKind.BUY, wallet_id=wallet.wallet_id,
                requested_amount=amount, executed_amount=0,
                success=False, reason=reason,
                stage_before=stage_before, stage_after=self.state.current_stage,
                buy_price_before=buy_price_before, sell_price_before=sell_price_before,
                treasury_before=treasury_before, total_sold_before=total_sold_before,
            )
            self.history.append(r)
            return r

        if amount <= 0:                          return fail("InvalidAmount")
        if amount > MAX_AMOUNT_PER_TX:           return fail("ExceedsMaxAmount")
        if self.is_finished():                   return fail("AllStagesComplete")

        remaining = self.remaining_in_stage()
        if amount > remaining:                   return fail("ExceedsStageSupply")

        total_cost = buy_price_before * amount
        if wallet.sol < total_cost:              return fail("InsufficientWalletSOL")

        # CEI — lib.rsと同じ順序
        self.state.treasury_balance           += total_cost
        self.state.treasury_actual_lamports   += total_cost
        self.state.stage_sold[stage_before]   += amount
        self.state.total_sold                 += amount

        # ステージ進行チェック
        if (self.state.stage_sold[stage_before] >= STAGE_SUPPLY[stage_before]
                and stage_before < len(STAGE_SUPPLY) - 1):
            sp_at_advance = self.sell_price()
            self.state.current_stage += 1
            self.stats.stage_advances += 1
            if self._current_actor == "bot":
                self.stats.bot_triggered_advances += 1
            new_bp = self.buy_price()
            downside = (1.0 - 0.995 * sp_at_advance / new_bp) if new_bp > 0 else 0.0
            self.stats.stage_transitions.append(StageTransitionSnapshot(
                stage_idx_before=stage_before,
                stage_idx_after=self.state.current_stage,
                treasury=self.state.treasury_balance,
                total_sold=self.state.total_sold,
                sell_price_before=sp_at_advance,
                new_buy_price=new_bp,
                immediate_downside=downside,
                trigger_actor=self._current_actor,
            ))

        wallet.sol             -= total_cost
        wallet.tokens          += amount
        wallet.total_buy_cost  += total_cost
        wallet.successful_buys += 1

        self.stats.buy_successes           += 1
        self.stats.total_buy_volume_tokens += amount
        self.stats.total_buy_volume_sol    += total_cost
        # stage別actor内訳を記録
        self.stats.stage_actor_buys[stage_before][self._current_actor] += amount

        r = TxResult(
            kind=TxKind.BUY, wallet_id=wallet.wallet_id,
            requested_amount=amount, executed_amount=amount,
            success=True, reason="ok",
            stage_before=stage_before, stage_after=self.state.current_stage,
            buy_price_before=buy_price_before, sell_price_before=sell_price_before,
            treasury_before=treasury_before, total_sold_before=total_sold_before,
            cost_paid=total_cost,
        )
        self.history.append(r)
        self.check_invariants(r)
        return r

    # ── core: sell ────────────────────────────────────────

    def sell(self, wallet: Wallet, amount: int) -> TxResult:
        self.stats.sell_attempts += 1

        stage_before      = self.state.current_stage
        buy_price_before  = self.buy_price()
        sell_price_before = self.sell_price()
        treasury_before   = self.state.treasury_balance
        total_sold_before = self.state.total_sold

        def fail(reason: str) -> TxResult:
            wallet.failed_sells += 1
            r = TxResult(
                kind=TxKind.SELL, wallet_id=wallet.wallet_id,
                requested_amount=amount, executed_amount=0,
                success=False, reason=reason,
                stage_before=stage_before, stage_after=self.state.current_stage,
                buy_price_before=buy_price_before, sell_price_before=sell_price_before,
                treasury_before=treasury_before, total_sold_before=total_sold_before,
            )
            self.history.append(r)
            return r

        if amount <= 0:                    return fail("InvalidAmount")
        if amount > MAX_AMOUNT_PER_TX:     return fail("ExceedsMaxAmount")
        if wallet.tokens < amount:         return fail("InsufficientWalletTokens")
        if self.state.total_sold < amount: return fail("InvalidAmount")  # lib.rsと同じ

        gross  = sell_price_before * amount
        spread = gross * SPREAD_BPS // 10_000
        payout = gross - spread

        if self.state.treasury_balance < payout + self.rent_minimum:
            return fail("InsufficientTreasury")

        # CEI — stage_soldは減らない（lib.rsと同じ）
        self.state.treasury_balance         -= payout
        self.state.treasury_actual_lamports -= payout
        self.state.total_sold               -= amount

        wallet.tokens              -= amount
        wallet.sol                 += payout
        wallet.total_sell_payout   += payout
        wallet.successful_sells    += 1

        self.stats.sell_successes            += 1
        self.stats.total_sell_volume_tokens  += amount
        self.stats.total_sell_payout_sol     += payout
        self.stats.total_spread_sol          += spread

        r = TxResult(
            kind=TxKind.SELL, wallet_id=wallet.wallet_id,
            requested_amount=amount, executed_amount=amount,
            success=True, reason="ok",
            stage_before=stage_before, stage_after=self.state.current_stage,
            buy_price_before=buy_price_before, sell_price_before=sell_price_before,
            treasury_before=treasury_before, total_sold_before=total_sold_before,
            payout_received=payout, spread_paid=spread,
        )
        self.history.append(r)
        self.check_invariants(r)
        return r

    def direct_treasury_transfer(self, lamports: int) -> None:
        """直接PDAへ送金（treasury_balanceには影響しない）"""
        if lamports > 0:
            self.state.treasury_actual_lamports += lamports


# ============================================================
# 初期状態プリセット
# ============================================================

def preset_stage2_done(
    n_wallets: int = 50,
    sol_per_wallet: int = 100 * SOL,
    distribution: str = "uniform",
    rng: Optional[random.Random] = None,
) -> Tuple[NautilusEngine, List[Wallet]]:
    """
    Stage 1-2消化済みの初期状態（human Stage 1,2 = idx 0,1 Done.）
    2M枚をウォレットに配布（ghost supplyなし）
    treasury = 2000 SOL、current_stage = 2（human Stage 3に居る）
    """
    if rng is None:
        rng = random.Random(42)

    engine = NautilusEngine()
    engine.state.current_stage            = 2
    engine.state.stage_sold[0]            = STAGE_SUPPLY[0]
    engine.state.stage_sold[1]            = STAGE_SUPPLY[1]
    engine.state.treasury_balance         = 2_000 * SOL
    engine.state.treasury_actual_lamports = 2_000 * SOL
    engine.state.total_sold               = 2_000_000

    wallets = [
        Wallet(wallet_id=i, sol=int(sol_per_wallet * rng.uniform(0.5, 1.5)))
        for i in range(n_wallets)
    ]

    total_tokens = 2_000_000
    if distribution == "uniform":
        per = total_tokens // n_wallets
        for w in wallets:
            w.tokens = per
        wallets[0].tokens += total_tokens - per * n_wallets
    elif distribution == "pareto":
        weights = [1.0 / (i + 1) ** 0.8 for i in range(n_wallets)]
        tw = sum(weights)
        rem = total_tokens
        for i, w in enumerate(wallets[:-1]):
            share = int(total_tokens * weights[i] / tw)
            w.tokens = share
            rem -= share
        wallets[-1].tokens = rem
    elif distribution == "random":
        cuts = sorted(rng.randint(0, total_tokens) for _ in range(n_wallets - 1))
        cuts = [0] + cuts + [total_tokens]
        for i, w in enumerate(wallets):
            w.tokens = cuts[i + 1] - cuts[i]

    return engine, wallets


# ============================================================
# Policy層 — clamp_to_remaining で挙動を切り替え
# ============================================================

def lognormal_amount(rng: random.Random, mean: int, sigma: float = 1.25) -> int:
    raw = int(math.exp(rng.gauss(math.log(max(mean, 1)), sigma)))
    return max(1, min(raw, MAX_AMOUNT_PER_TX))


def _hold(engine: NautilusEngine, wallet: Wallet, reason: str) -> TxResult:
    return TxResult(
        kind=TxKind.HOLD, wallet_id=wallet.wallet_id,
        requested_amount=0, executed_amount=0,
        success=False, reason=reason,
        stage_before=engine.state.current_stage,
        stage_after=engine.state.current_stage,
        buy_price_before=engine.buy_price(),
        sell_price_before=engine.sell_price(),
        treasury_before=engine.state.treasury_balance,
        total_sold_before=engine.state.total_sold,
    )


def organic_policy(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: Wallet,
    buy_prob: float = 0.55,
    mean_tokens: int = 20_000,
    clamp_to_remaining: bool = True,
) -> TxResult:
    """
    普通のホルダー: ランダムにbuy/sell

    clamp_to_remaining=True  → UI/普通ユーザー向け（残量にclamp）
    clamp_to_remaining=False → 生のprotocol interaction向け（rejectのまま）
    """
    if rng.random() < buy_prob:
        amount = lognormal_amount(rng, mean_tokens)
        if clamp_to_remaining:
            remaining = engine.remaining_in_stage()
            amount = min(amount, remaining)
            if amount <= 0:
                return _hold(engine, wallet, "NoRemainingInStage")
        engine._current_actor = "organic"
        return engine.buy(wallet, amount)
    else:
        if wallet.tokens <= 0:
            return _hold(engine, wallet, "NoTokensToSell")
        amount = lognormal_amount(rng, mean_tokens)
        amt = min(amount, wallet.tokens)
        return engine.sell(wallet, amt)


def bot_policy(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: Wallet,
    mean_tokens: int = 10_000,
    clamp_to_remaining: bool = True,
) -> Tuple[TxResult, TxResult]:
    """cyclic bot: buy→sell即往復"""
    amount = lognormal_amount(rng, mean_tokens)
    if clamp_to_remaining:
        remaining = engine.remaining_in_stage()
        amount = min(amount, remaining)
        if amount <= 0:
            h = _hold(engine, wallet, "NoRemainingInStage")
            return h, h
    engine._current_actor = "bot"
    buy_r = engine.buy(wallet, amount)
    if buy_r.success:
        sell_r = engine.sell(wallet, buy_r.executed_amount)
        engine.stats.bot_total_cost   += buy_r.cost_paid
        engine.stats.bot_total_payout += sell_r.payout_received
        return buy_r, sell_r
    return buy_r, buy_r


def whale_policy(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: Wallet,
    exit_prob: float = 0.2,
    max_chunks: int = 20,
    mean_tokens: int = 200_000,
    clamp_to_remaining: bool = True,
) -> List[TxResult]:
    """whale: 大量buy、たまにexit"""
    results = []
    if rng.random() > exit_prob:
        n = rng.randint(3, max_chunks)
        for _ in range(n):
            if engine.is_finished():
                break
            amount = lognormal_amount(rng, mean_tokens, sigma=0.8)
            if clamp_to_remaining:
                remaining = engine.remaining_in_stage()
                amount = min(amount, remaining)
                if amount <= 0:
                    break
            engine._current_actor = "whale"
            results.append(engine.buy(wallet, amount))
    else:
        if wallet.tokens > 0:
            amt = min(wallet.tokens // 3, MAX_AMOUNT_PER_TX)
            if amt > 0:
                results.append(engine.sell(wallet, amt))
    return results


# ============================================================
# Monte Carlo ランナー
# ============================================================

@dataclass
class MonteCarloConfig:
    seed:               int   = 42
    n_wallets:          int   = 50
    n_steps:            int   = 10_000
    sol_per_wallet:     int   = 100 * SOL
    distribution:       str   = "uniform"
    organic_prob:       float = 0.6
    bot_prob:           float = 0.2
    whale_prob:         float = 0.1
    mean_tx:            int   = 20_000
    clamp_to_remaining: bool  = True


def run_single(cfg: MonteCarloConfig) -> Tuple[NautilusEngine, List[Wallet]]:
    """1試行を実行"""
    rng = random.Random(cfg.seed)
    engine, wallets = preset_stage2_done(
        n_wallets=cfg.n_wallets,
        sol_per_wallet=cfg.sol_per_wallet,
        distribution=cfg.distribution,
        rng=rng,
    )
    whale_wallet = wallets[0]

    for _ in range(cfg.n_steps):
        if engine.is_finished():
            break
        r = rng.random()
        w = wallets[rng.randrange(len(wallets))]

        if r < cfg.organic_prob:
            organic_policy(rng, engine, w,
                           mean_tokens=cfg.mean_tx,
                           clamp_to_remaining=cfg.clamp_to_remaining)
        elif r < cfg.organic_prob + cfg.bot_prob:
            bot_policy(rng, engine, w,
                       mean_tokens=cfg.mean_tx,
                       clamp_to_remaining=cfg.clamp_to_remaining)
        elif r < cfg.organic_prob + cfg.bot_prob + cfg.whale_prob:
            whale_policy(rng, engine, whale_wallet,
                         mean_tokens=cfg.mean_tx * 5,
                         clamp_to_remaining=cfg.clamp_to_remaining)

        engine.stats.total_steps += 1

    return engine, wallets


def run_mc(cfg: MonteCarloConfig, n_trials: int = 500) -> Dict:
    """
    Monte Carlo: n_trials回試行して統計を出す。
    特にstage transition downsideの分布を集計する。
    """
    all_transitions: Dict[Tuple[int,int], List[float]] = defaultdict(list)
    all_actors:      Dict[Tuple[int,int], List[str]]  = defaultdict(list)
    final_stages: List[int] = []
    violations_total = 0

    for trial in range(n_trials):
        trial_cfg = MonteCarloConfig(
            seed=cfg.seed + trial,
            n_wallets=cfg.n_wallets,
            n_steps=cfg.n_steps,
            sol_per_wallet=cfg.sol_per_wallet,
            distribution=cfg.distribution,
            organic_prob=cfg.organic_prob,
            bot_prob=cfg.bot_prob,
            whale_prob=cfg.whale_prob,
            mean_tx=cfg.mean_tx,
            clamp_to_remaining=cfg.clamp_to_remaining,
        )
        engine, _ = run_single(trial_cfg)
        final_stages.append(engine.state.current_stage)
        violations_total += engine.stats.invariant_violations

        for t in engine.stats.stage_transitions:
            key = (t.stage_idx_before, t.stage_idx_after)
            all_transitions[key].append(t.immediate_downside * 100)
            all_actors[key].append(t.trigger_actor)

    return {
        "n_trials":           n_trials,
        "final_stages":       final_stages,
        "violations_total":   violations_total,
        "all_transitions":    dict(all_transitions),
        "all_actors":         dict(all_actors),
    }


# ============================================================
# 結果表示
# ============================================================

def print_single(label: str, engine: NautilusEngine, wallets: List[Wallet]) -> None:
    from collections import Counter
    s    = engine.stats
    snap = engine.snapshot()
    sp   = engine.sell_price()

    print(f"\n{'='*70}")
    print(f"  {label}")
    print(f"{'='*70}")
    print(f"  最終Stage (human)  : Stage {snap['stage_human']}  (idx={snap['stage_idx']})")
    print(f"  buy_price          : {snap['buy_price_sol']:.6f} SOL")
    print(f"  sell_price         : {snap['sell_price_sol']:.6f} SOL")
    print(f"  treasury           : {snap['treasury_sol']:.2f} SOL")
    print(f"  total_sold         : {snap['total_sold']:,}")
    print(f"  stage進行回数      : {s.stage_advances}")
    print(f"  invariant違反      : {s.invariant_violations}")
    print()
    print(f"  buy成功/試行       : {s.buy_successes:,} / {s.buy_attempts:,}")
    print(f"  sell成功/試行      : {s.sell_successes:,} / {s.sell_attempts:,}")
    print(f"  スプレッド蓄積     : {s.total_spread_sol/SOL:.2f} SOL")

    fail_reasons = Counter(r.reason for r in engine.history if not r.success and r.reason not in ("NoRemainingInStage", "NoTokensToSell"))
    if fail_reasons:
        print(f"\n  失敗理由 (protocol level):")
        for reason, cnt in fail_reasons.most_common():
            print(f"    {reason:30s}: {cnt:,}")

    # stage別actor内訳
    if s.stage_actor_buys:
        print(f"\n  Stage別 買い枚数内訳 (organic / bot / whale):")
        print(f"  {'Stage':>8}  {'organic':>12}  {'bot':>12}  {'whale':>12}  {'計':>12}  bot率")
        print(f"  {'-'*68}")
        for stage_idx in sorted(s.stage_actor_buys.keys()):
            d     = s.stage_actor_buys[stage_idx]
            org   = d.get("organic", 0)
            bot   = d.get("bot", 0)
            whl   = d.get("whale", 0)
            total = org + bot + whl
            bot_r = bot / total * 100 if total > 0 else 0
            print(f"  Stage {human_stage(stage_idx):>2}   {org:>12,}  {bot:>12,}  {whl:>12,}  {total:>12,}  {bot_r:>5.1f}%")

    # bot損失サマリー
    if s.bot_total_cost > 0:
        bot_loss = s.bot_total_cost - s.bot_total_payout
        bot_loss_pct = bot_loss / s.bot_total_cost * 100
        loss_per_adv = bot_loss / s.bot_triggered_advances / SOL if s.bot_triggered_advances > 0 else 0
        print(f"\n  bot損失サマリー:")
        print(f"    総損失         : {bot_loss/SOL:>8.2f} SOL ({bot_loss_pct:.2f}%)")
        print(f"    stage advance起因: {s.bot_triggered_advances}回")
        print(f"    advance 1回あたり: {loss_per_adv:>8.2f} SOL")

    # stage transition snapshots
    if s.stage_transitions:
        print(f"\n  Stage進行時スナップショット:")
        print(f"  {'進行 (human)':>14}  {'treasury':>10}  {'total_sold':>12}  "
              f"{'sell_price':>12}  {'new_buy':>12}  {'即売downside':>14}")
        print(f"  {'-'*80}")
        for t in s.stage_transitions:
            print(f"  Stage {t.human_before}→{t.human_after:<4}      "
                  f"  {t.treasury/SOL:>10.2f}  {t.total_sold:>12,}  "
                  f"  {t.sell_price_before/SOL:>10.6f}  {t.new_buy_price/SOL:>10.6f}  "
                  f"  {t.immediate_downside*100:>10.2f}% down  [{t.trigger_actor}]")

    # 上位ホルダー
    top = sorted(wallets, key=lambda w: w.tokens, reverse=True)[:3]
    print(f"\n  上位3ウォレット:")
    for w in top:
        mtm = w.mark_to_market(sp)
        print(f"    wallet_{w.wallet_id}: {w.tokens:>10,}枚  "
              f"realized={w.pnl()/SOL:>+8.2f} SOL ({w.pnl_pct():>+6.1f}%)  "
              f"MTM={mtm/SOL:>8.2f} SOL")


def print_mc(label: str, result: Dict) -> None:
    stages  = result["final_stages"]
    n       = result["n_trials"]
    trans   = result["all_transitions"]
    viols   = result["violations_total"]

    from collections import Counter
    dist = Counter(stages)

    print(f"\n{'='*70}")
    print(f"  {label}")
    print(f"  Monte Carlo: {n}試行")
    print(f"{'='*70}")
    print(f"  平均最終Stage (human): {sum(human_stage(s) for s in stages)/n:.2f}")
    print(f"  invariant violations  : {viols} 件 / {n} 試行")

    print(f"\n  Stage Distribution (human):")
    for idx_s in sorted(dist):
        pct = dist[idx_s] / n * 100
        bar = '█' * int(pct / 2)
        print(f"    Stage {human_stage(idx_s):>2}: {pct:>5.1f}%  {bar}")

    if trans:
        print(f"\n  Stage進行時の即売downside分布 + trigger actor:")
        print(f"  {'進行 (human)':>14}  {'試行数':>6}  {'平均':>10}  {'最小':>10}  {'最大':>10}  organic  bot  whale")
        print(f"  {'-'*80}")
        for (idx_b, idx_a), vals in sorted(trans.items()):
            avg = sum(vals) / len(vals)
            actors = result["all_actors"].get((idx_b, idx_a), [])
            from collections import Counter
            ac = Counter(actors)
            total_a = len(actors) or 1
            print(f"  Stage {human_stage(idx_b)}→{human_stage(idx_a):<4}      "
                  f"  {len(vals):>6}  {avg:>8.2f}%  {min(vals):>8.2f}%  {max(vals):>8.2f}%"
                  f"  {ac.get('organic',0):>7}  {ac.get('bot',0):>3}  {ac.get('whale',0):>5}")

    print(f"\n  note: realized = confirmed gain/loss from completed sells only")
    print(f"  note: net      = final_wealth - initial_wealth (includes unrealized)")


# ============================================================
# メイン
# ============================================================

# ============================================================
# Market Simulator (cohort-based policy layer)
# ============================================================



import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from collections import defaultdict
from dataclasses import dataclass, field
import math
import random
from typing import Dict, List, Optional, Tuple

from nautilus_mc_engine import (
    NautilusEngine, Wallet, TxResult, TxKind,
    preset_stage2_done, lognormal_amount, _hold,
    SOL, human_stage, STAGE_SUPPLY,
)


# ============================================================
# Walletを拡張してcohort情報を追加
# ============================================================

@dataclass
class CohortWallet(Wallet):
    cohort:                   str       = "unknown"
    entry_stages:             List[int] = field(default_factory=list)
    exit_stages:              List[int] = field(default_factory=list)
    entry_prices:             List[int] = field(default_factory=list)
    holding_steps:            int       = 0
    cost_basis:               int       = 0  # 現在保有トークンの取得コスト
    # initial wealth（P&L基準）
    initial_sol:              int       = 0  # SOL at simulation start
    initial_tokens:           int       = 0  # tokens at simulation start
    initial_token_cost_basis: int       = 0  # cost basis of initial token allocation

    def net_pnl(self, sell_price: int) -> int:
        """
        Net PnL vs initial wealth (lamports).
        final_wealth - initial_wealth
        """
        final_wealth   = self.sol + self.tokens * sell_price
        initial_wealth = self.initial_sol + self.initial_token_cost_basis
        return final_wealth - initial_wealth

    def net_pnl_pct(self, sell_price: int) -> float:
        initial_wealth = self.initial_sol + self.initial_token_cost_basis
        if initial_wealth == 0:
            return 0.0
        return self.net_pnl(sell_price) / initial_wealth * 100


def make_cohort_wallets(
    cohort_sizes: Dict[str, int],
    sol_per_wallet: int,
    rng: random.Random,
) -> List[CohortWallet]:
    """Create wallets grouped by cohort."""
    wallets = []
    wallet_id = 0
    for cohort, n in cohort_sizes.items():
        for _ in range(n):
            sol = int(sol_per_wallet * rng.uniform(0.5, 1.5))
            w = CohortWallet(wallet_id=wallet_id, sol=sol, cohort=cohort)
            w.initial_sol = sol  # 初期SOLを記録
            wallets.append(w)
            wallet_id += 1
    return wallets


# ============================================================
# cohort別policy
# ============================================================

def _record_buy(wallet: CohortWallet, result: TxResult, engine: NautilusEngine):
    if result.success:
        wallet.entry_stages.append(result.stage_before)
        wallet.entry_prices.append(result.buy_price_before)
        wallet.cost_basis += result.cost_paid


def _record_sell(wallet: CohortWallet, result: TxResult, engine: NautilusEngine):
    if result.success:
        wallet.exit_stages.append(result.stage_before)
        # cost_basisを比例減算
        if wallet.tokens + result.executed_amount > 0:
            ratio = result.executed_amount / (wallet.tokens + result.executed_amount)
            wallet.cost_basis = int(wallet.cost_basis * (1 - ratio))


def policy_early_believer(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: CohortWallet,
    step: int,
    mean_tokens: int = 50_000,
) -> Optional[TxResult]:
    """
    早期参入者: Stage 3-4の間に積極的にbuy、以後はHODL。
    Stage 5以降はほぼ売らない。
    """
    stage = engine.state.current_stage
    if stage <= 3:  # human Stage 3-4
        # 積極的にbuy
        if rng.random() < 0.7:
            amt = lognormal_amount(rng, mean_tokens)
            remaining = engine.remaining_in_stage()
            amt = min(amt, remaining)
            if amt <= 0:
                return None
            engine._current_actor = "early_believer"
            r = engine.buy(wallet, amt)
            _record_buy(wallet, r, engine)
            return r
    # 高ステージではほぼ売らない（5%のみ利確）
    elif rng.random() < 0.05 and wallet.tokens > 0:
        amt = min(lognormal_amount(rng, mean_tokens // 4), wallet.tokens)
        engine._current_actor = "early_believer"
        r = engine.sell(wallet, amt)
        _record_sell(wallet, r, engine)
        return r
    return None


def policy_fomo_buyer(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: CohortWallet,
    step: int,
    mean_tokens: int = 30_000,
) -> Optional[TxResult]:
    """
    FOMO buyer: stageが進んだ直後に買いに来る。
    Stage 4以降にアクティブ。
    """
    stage = engine.state.current_stage
    if stage < 2:  # human Stage 3未満はスルー
        return None

    # stageが高いほど参加確率が上がる（FOMO）
    buy_prob = min(0.3 + stage * 0.05, 0.7)
    if rng.random() < buy_prob:
        amt = lognormal_amount(rng, mean_tokens)
        remaining = engine.remaining_in_stage()
        amt = min(amt, remaining)
        if amt <= 0:
            return None
        engine._current_actor = "fomo_buyer"
        r = engine.buy(wallet, amt)
        _record_buy(wallet, r, engine)
        return r

    # 一部は利確
    if wallet.tokens > 0 and rng.random() < 0.15:
        amt = min(lognormal_amount(rng, mean_tokens // 3), wallet.tokens)
        engine._current_actor = "fomo_buyer"
        r = engine.sell(wallet, amt)
        _record_sell(wallet, r, engine)
        return r
    return None


def policy_dip_buyer(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: CohortWallet,
    step: int,
    mean_tokens: int = 30_000,
    threshold: float = 0.60,  # sell_price / buy_price がこれ以上の時に買う（緩い閾値）
) -> Optional[TxResult]:
    """
    dip buyer: sell_price が buy_price に対して一定水準の時だけ買う。
    stage直後の極端な高値は避けるが、ある程度は参加する。
    0枚スタートなので積極的に買いに行く必要がある。
    """
    bp = engine.buy_price()
    sp = engine.sell_price()
    if bp == 0:
        return None

    ratio = sp / bp if bp > 0 else 0

    if ratio >= threshold:
        # 条件を満たす → buy（積極的に）
        if rng.random() < 0.65:
            amt = lognormal_amount(rng, mean_tokens)
            remaining = engine.remaining_in_stage()
            amt = min(amt, remaining)
            if amt <= 0:
                return None
            engine._current_actor = "dip_buyer"
            r = engine.buy(wallet, amt)
            _record_buy(wallet, r, engine)
            return r
    else:
        # 高値圏 → 様子見（持ってれば少し売る）
        if wallet.tokens > 0 and rng.random() < 0.15:
            amt = min(lognormal_amount(rng, mean_tokens // 3), wallet.tokens)
            engine._current_actor = "dip_buyer"
            r = engine.sell(wallet, amt)
            _record_sell(wallet, r, engine)
            return r
    return None


def policy_panic_seller(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: CohortWallet,
    step: int,
    mean_tokens: int = 40_000,
    loss_threshold: float = 0.85,  # 持ち値の85%を下回ったら売る
) -> Optional[TxResult]:
    """
    panic seller: 持ち値より下回ったらすぐ売る。
    最初は少し買うが、すぐ怖くなる。
    """
    sp = engine.sell_price()

    # まず少し買う
    if wallet.tokens == 0 and rng.random() < 0.3:
        amt = lognormal_amount(rng, mean_tokens)
        remaining = engine.remaining_in_stage()
        amt = min(amt, remaining)
        if amt > 0:
            engine._current_actor = "panic_seller"
            r = engine.buy(wallet, amt)
            _record_buy(wallet, r, engine)
            return r

    # 持ち値チェック → パニック売り
    if wallet.tokens > 0 and wallet.cost_basis > 0:
        avg_cost = wallet.cost_basis // wallet.tokens
        if sp < avg_cost * loss_threshold:
            # パニック売り
            amt = min(lognormal_amount(rng, mean_tokens), wallet.tokens)
            engine._current_actor = "panic_seller"
            r = engine.sell(wallet, amt)
            _record_sell(wallet, r, engine)
            return r

    return None


def policy_take_profit(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: CohortWallet,
    step: int,
    mean_tokens: int = 30_000,
    profit_target: float = 1.5,  # 1.5倍で分割利確
) -> Optional[TxResult]:
    """
    take-profit seller: 一定倍率に達したら分割で利確。
    """
    sp = engine.sell_price()

    # まず買う
    if wallet.tokens < 100_000 and rng.random() < 0.4:
        amt = lognormal_amount(rng, mean_tokens)
        remaining = engine.remaining_in_stage()
        amt = min(amt, remaining)
        if amt > 0:
            engine._current_actor = "take_profit"
            r = engine.buy(wallet, amt)
            _record_buy(wallet, r, engine)
            return r

    # 利確チェック
    if wallet.tokens > 0 and wallet.cost_basis > 0:
        avg_cost = wallet.cost_basis // wallet.tokens
        if sp >= avg_cost * profit_target:
            # 1/3を利確
            amt = min(wallet.tokens // 3, lognormal_amount(rng, mean_tokens))
            if amt > 0:
                engine._current_actor = "take_profit"
                r = engine.sell(wallet, amt)
                _record_sell(wallet, r, engine)
                return r

    return None


def policy_dca_holder(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: CohortWallet,
    step: int,
    mean_tokens: int = 10_000,
    buy_interval: int = 50,  # 50ステップごとに買う
) -> Optional[TxResult]:
    """
    DCA holder: 定期的に小口で買い続ける。売らない。
    """
    if step % buy_interval == 0 and rng.random() < 0.8:
        amt = lognormal_amount(rng, mean_tokens, sigma=0.5)
        remaining = engine.remaining_in_stage()
        amt = min(amt, remaining)
        if amt <= 0:
            return None
        engine._current_actor = "dca_holder"
        r = engine.buy(wallet, amt)
        _record_buy(wallet, r, engine)
        return r
    return None


def policy_late_chaser(
    rng: random.Random,
    engine: NautilusEngine,
    wallet: CohortWallet,
    step: int,
    mean_tokens: int = 40_000,
    entry_stage: int = 3,  # human Stage 4以降に参入（idx=3）
) -> Optional[TxResult]:
    """
    late chaser: stageが進んだ後から飛び乗る。
    初期はスルー、ある程度進んだら積極的に参入。
    高値掴みのリスクあり（FOMO的だがより遅い）。
    """
    stage = engine.state.current_stage
    if stage < entry_stage:
        return None  # 指定stage未満はスルー

    # stageが上がるほど積極的に買う（遅れてきた熱狂）
    buy_prob = min(0.4 + (stage - entry_stage) * 0.1, 0.75)
    if rng.random() < buy_prob:
        amt = lognormal_amount(rng, mean_tokens)
        remaining = engine.remaining_in_stage()
        amt = min(amt, remaining)
        if amt <= 0:
            return None
        engine._current_actor = "late_chaser"
        r = engine.buy(wallet, amt)
        _record_buy(wallet, r, engine)
        return r

    # 少し利確
    if wallet.tokens > 0 and rng.random() < 0.15:
        amt = min(lognormal_amount(rng, mean_tokens // 3), wallet.tokens)
        engine._current_actor = "late_chaser"
        r = engine.sell(wallet, amt)
        _record_sell(wallet, r, engine)
        return r

    return None


COHORT_POLICIES = {
    "early_believer": policy_early_believer,
    "fomo_buyer":     policy_fomo_buyer,
    "dip_buyer":      policy_dip_buyer,
    "panic_seller":   policy_panic_seller,
    "take_profit":    policy_take_profit,
    "dca_holder":     policy_dca_holder,
    "late_chaser":    policy_late_chaser,
}


# ============================================================
# シミュレーション実行
# ============================================================

def run_market_sim(
    cohort_sizes: Dict[str, int],
    n_steps: int = 50_000,
    sol_per_wallet: int = 200 * SOL,
    seed: int = 42,
) -> Tuple[NautilusEngine, List[CohortWallet]]:
    rng = random.Random(seed)

    engine = NautilusEngine()
    engine.state.current_stage            = 2
    engine.state.stage_sold[0]            = STAGE_SUPPLY[0]
    engine.state.stage_sold[1]            = STAGE_SUPPLY[1]
    engine.state.treasury_balance         = 2_000 * SOL
    engine.state.treasury_actual_lamports = 2_000 * SOL
    engine.state.total_sold               = 2_000_000

    wallets = make_cohort_wallets(cohort_sizes, sol_per_wallet, rng)

    # Distribute initial tokens to holder cohorts only.
    # early_believer / take_profit / dca_holder receive initial token allocation.
    # fomo_buyer / late_chaser / dip_buyer / panic_seller start with 0 tokens.
    INITIAL_HOLDER_COHORTS = {"early_believer", "take_profit", "dca_holder"}
    initial_holders = [w for w in wallets if w.cohort in INITIAL_HOLDER_COHORTS]

    initial_tokens = 2_000_000
    initial_cost_per_token = BASE_PRICE_LAMPORTS  # 0.001 SOL

    if initial_holders:
        per = initial_tokens // len(initial_holders)
        for w in initial_holders:
            w.tokens                  = per
            w.cost_basis              = per * initial_cost_per_token
            w.initial_tokens          = per
            w.initial_token_cost_basis = per * initial_cost_per_token
            w.entry_stages.append(1)  # Stage 2 equivalent
            w.entry_prices.append(initial_cost_per_token)
        remainder = initial_tokens - per * len(initial_holders)
        if remainder > 0:
            initial_holders[0].tokens              += remainder
            initial_holders[0].cost_basis          += remainder * initial_cost_per_token
            initial_holders[0].initial_tokens      += remainder
            initial_holders[0].initial_token_cost_basis += remainder * initial_cost_per_token

    for step in range(n_steps):
        if engine.is_finished():
            break

        # ランダムにウォレットを選んでcohort policyを実行
        w = wallets[rng.randrange(len(wallets))]
        policy_fn = COHORT_POLICIES.get(w.cohort)
        if policy_fn:
            policy_fn(rng, engine, w, step)

        # holding_stepsをインクリメント
        for wallet in wallets:
            if wallet.tokens > 0:
                wallet.holding_steps += 1

        engine.stats.total_steps += 1

    return engine, wallets


# ============================================================
# 結果表示
# ============================================================

def print_market_results(
    label: str,
    engine: NautilusEngine,
    wallets: List[CohortWallet],
) -> None:
    snap = engine.snapshot()
    sp   = engine.sell_price()
    s    = engine.stats

    print(f"\n{'='*70}")
    print(f"  {label}")
    print(f"{'='*70}")
    print(f"  Final Stage  : Stage {snap['stage_human']}  (idx={snap['stage_idx']})")
    print(f"  buy_price   : {snap['buy_price_sol']:.6f} SOL")
    print(f"  sell_price  : {snap['sell_price_sol']:.6f} SOL")
    print(f"  treasury    : {snap['treasury_sol']:.2f} SOL")
    print(f"  total_sold  : {snap['total_sold']:,}")
    print(f"  Spread accrued: {s.total_spread_sol/SOL:.2f} SOL")

    # stage transition snapshot
    if s.stage_transitions:
        print(f"\n  Stage Advance Snapshots:")
        print(f"  {'進行':>10}  {'treasury':>10}  {'sold':>10}  {'downside':>10}")
        print(f"  {'-'*48}")
        for t in s.stage_transitions:
            print(f"  Stage {t.human_before}→{t.human_after:<4}  "
                  f"  {t.treasury/SOL:>8.1f}  {t.total_sold:>10,}  "
                  f"  {t.immediate_downside*100:>8.2f}%")

    # cohort別集計
    cohort_stats: Dict[str, Dict] = defaultdict(lambda: {
        "n": 0, "realized": 0, "mtm": 0, "tokens": 0,
        "net_pnl": 0, "net_pnl_pct": 0.0,
        "wins": 0, "losses": 0, "holding_steps": 0,
        "entry_stages": [], "exit_stages": [],
    })

    for w in wallets:
        cs = cohort_stats[w.cohort]
        realized = w.pnl()
        mtm      = w.mark_to_market(sp)
        net      = w.net_pnl(sp)
        net_pct  = w.net_pnl_pct(sp)
        cs["n"]            += 1
        cs["realized"]     += realized
        cs["mtm"]          += mtm
        cs["tokens"]       += w.tokens
        cs["net_pnl"]      += net
        cs["net_pnl_pct"]  += net_pct
        cs["holding_steps"] += w.holding_steps
        cs["entry_stages"].extend(w.entry_stages)
        cs["exit_stages"].extend(w.exit_stages)
        if net > 0:
            cs["wins"] += 1
        else:
            cs["losses"] += 1

    print(f"\n  Cohort P&L Summary (vs initial wealth):")
    print(f"  {'cohort':>16}  {'n':>5}  {'avg net P&L':>13}  {'net P&L%':>9}  "
          f"{'avg realized':>12}  {'avg MTM':>12}  {'avg entry':>10}")
    print(f"  {'-'*92}")

    for cohort, cs in sorted(cohort_stats.items()):
        n = cs["n"]
        if n == 0:
            continue
        avg_net_pnl  = cs["net_pnl"] / n / SOL
        avg_net_pct  = cs["net_pnl_pct"] / n
        avg_realized = cs["realized"] / n / SOL
        avg_mtm      = cs["mtm"] / n / SOL
        avg_tokens   = cs["tokens"] / n
        avg_entry    = (sum(cs["entry_stages"]) / len(cs["entry_stages"])
                        if cs["entry_stages"] else 0)
        avg_entry_h  = human_stage(int(avg_entry)) if cs["entry_stages"] else "-"
        print(f"  {cohort:>16}  {n:>5}  {avg_net_pnl:>+11.2f} SOL  "
              f"  {avg_net_pct:>+7.1f}%  {avg_realized:>+10.2f} SOL  "
              f"  {avg_mtm:>10.2f} SOL  Stage {avg_entry_h}")

    # entry stage別の収支
    print(f"\n  Immediate downside at each stage advance:")
    for t in s.stage_transitions:
        print(f"    Stage {t.human_before}→{t.human_after}: "
              f"immediate downside {t.immediate_downside*100:.2f}%  "
              f"[{t.trigger_actor}]")

    # wealth transfer
    total_spread = s.total_spread_sol / SOL
    total_sell_payout = s.total_sell_payout_sol / SOL
    print(f"\n  Wealth Transfer:")
    print(f"    spread accrued (sellers → holders): {total_spread:.2f} SOL")
    print(f"    total sell payouts              : {total_sell_payout:.2f} SOL")
    print(f"    final treasury                : {snap['treasury_sol']:.2f} SOL")


# ============================================================
# シナリオ定義
# ============================================================

SCENARIOS = {
    "A_calm": {
        "label": "Scenario A: Calm market (early believers dominant)",
        "cohort_sizes": {
            "early_believer": 20,
            "fomo_buyer":      5,
            "dip_buyer":       5,
            "panic_seller":    3,
            "take_profit":     5,
            "dca_holder":     10,
            "late_chaser":     2,
        },
    },
    "B_volatile": {
        "label": "Scenario B: Volatile market (panic sellers dominant)",
        "cohort_sizes": {
            "early_believer":  5,
            "fomo_buyer":     10,
            "dip_buyer":      10,
            "panic_seller":   15,
            "take_profit":     5,
            "dca_holder":      3,
            "late_chaser":     2,
        },
    },
    "C_late_rush": {
        "label": "Scenario C: Late rush (late chasers flood in)",
        "cohort_sizes": {
            "early_believer": 10,
            "fomo_buyer":      5,
            "dip_buyer":       3,
            "panic_seller":    2,
            "take_profit":     5,
            "dca_holder":      5,
            "late_chaser":    20,
        },
    },
    "D_steady": {
        "label": "Scenario D: Steady market (DCA + take-profit balanced)",
        "cohort_sizes": {
            "early_believer":  5,
            "fomo_buyer":      3,
            "dip_buyer":       5,
            "panic_seller":    2,
            "take_profit":    15,
            "dca_holder":     15,
            "late_chaser":     5,
        },
    },
}


# ============================================================
# メイン
# ============================================================


# ============================================================
# Monte Carlo集計
# ============================================================

def run_market_mc(
    scenario_key: str,
    cohort_sizes: Dict[str, int],
    n_trials: int = 300,
    n_steps: int = 50_000,
    sol_per_wallet: int = 200 * SOL,
    base_seed: int = 42,
) -> Dict:
    """
    n_trials回試行してcohort別の平均net P&Lを集計する。
    """
    from collections import defaultdict

    cohort_net_pnl:  Dict[str, List[float]] = defaultdict(list)
    cohort_net_pct:  Dict[str, List[float]] = defaultdict(list)
    final_stages:    List[int]              = []
    all_spreads:     List[float]            = []

    for trial in range(n_trials):
        if (trial + 1) % 100 == 0:
            print(f"    {trial+1}/{n_trials}...", flush=True)
        engine, wallets = run_market_sim(
            cohort_sizes=cohort_sizes,
            n_steps=n_steps,
            sol_per_wallet=sol_per_wallet,
            seed=base_seed + trial,
        )
        sp = engine.sell_price()
        final_stages.append(engine.state.current_stage)
        all_spreads.append(engine.stats.total_spread_sol / SOL)

        # cohort別にnet P&Lを集計
        cohort_totals: Dict[str, Dict] = defaultdict(lambda: {"net": 0, "pct": 0.0, "n": 0})
        for w in wallets:
            net = w.net_pnl(sp)
            pct = w.net_pnl_pct(sp)
            cohort_totals[w.cohort]["net"] += net
            cohort_totals[w.cohort]["pct"] += pct
            cohort_totals[w.cohort]["n"]   += 1

        for cohort, data in cohort_totals.items():
            n = data["n"]
            if n > 0:
                cohort_net_pnl[cohort].append(data["net"] / n / SOL)
                cohort_net_pct[cohort].append(data["pct"] / n)

    return {
        "scenario_key":   scenario_key,
        "n_trials":       n_trials,
        "final_stages":   final_stages,
        "all_spreads":    all_spreads,
        "cohort_net_pnl": dict(cohort_net_pnl),
        "cohort_net_pct": dict(cohort_net_pct),
    }


def print_mc_results(result: Dict) -> None:
    from collections import Counter
    n         = result["n_trials"]
    stages    = result["final_stages"]
    spreads   = result["all_spreads"]
    pnl_data  = result["cohort_net_pnl"]
    pct_data  = result["cohort_net_pct"]

    dist = Counter(stages)

    print(f"  Trials        : {n}")
    print(f"  Avg final stage : Stage {sum(human_stage(s) for s in stages)/n:.1f}")
    print(f"  Avg spread accrued : {sum(spreads)/len(spreads):.1f} SOL")

    print(f"\n  Stage Distribution:")
    for idx_s in sorted(dist):
        pct = dist[idx_s] / n * 100
        bar = '█' * int(pct / 3)
        print(f"    Stage {human_stage(idx_s):>2}: {pct:>5.1f}%  {bar}")

    print(f"\n  Cohort net P&L（{n}-trial average）:")
    print(f"  {'cohort':>16}  {'avg net/wallet':>13}  {'avg net%':>9}  {'win%':>6}  {'min':>10}  {'max':>10}")
    print(f"  {'-'*72}")

    for cohort in sorted(pnl_data.keys()):
        vals = pnl_data[cohort]
        pcts = pct_data[cohort]
        avg_pnl = sum(vals) / len(vals)
        avg_pct = sum(pcts) / len(pcts)
        win_rate = sum(1 for v in vals if v > 0) / len(vals) * 100
        print(f"  {cohort:>16}  {avg_pnl:>+11.2f} SOL  "
              f"  {avg_pct:>+7.1f}%  {win_rate:>5.1f}%  "
              f"  {min(vals):>+8.1f}  {max(vals):>+8.1f}")


if __name__ == "__main__":
    print("=" * 70)
    print("Nautilus Market Simulator")
    print("Who wins and who loses?")
    print("Engine: nautilus_mc_engine.py")
    print("=" * 70)

    # ── Single run: detailed view ──────────────────────────
    for scenario_key, scenario in SCENARIOS.items():
        engine, wallets = run_market_sim(
            cohort_sizes=scenario["cohort_sizes"],
            n_steps=50_000,
            sol_per_wallet=200 * SOL,
            seed=42,
        )
        print_market_results(scenario["label"], engine, wallets)

    # ── Monte Carlo: 500 trials per scenario ───────────────
    print(f"\n\n{'='*70}")
    print("Monte Carlo Results (500 trials per scenario)")
    print("=" * 70)

    for scenario_key, scenario in SCENARIOS.items():
        print(f"\n{'='*70}")
        print(f"  MC: {scenario['label']}")
        print(f"{'='*70}")
        result = run_market_mc(
            scenario_key=scenario_key,
            cohort_sizes=scenario["cohort_sizes"],
            n_trials=500,
            n_steps=30_000,
            sol_per_wallet=200 * SOL,
        )
        print_mc_results(result)

    print(f"\n{'='*70}")
    print("Done.")
    print("=" * 70)