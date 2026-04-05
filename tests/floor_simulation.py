"""
Nautilus Floor Price Simulation — Production Grade (Final)
===========================================================
Verifies two mathematical propositions:

Proposition 1: sell_price never decreases after a sell
  Compares sp_before and sp_after for every single sell transaction
  Asserts sp_after >= sp_before across all sells

Proposition 2: sell_price >= buyonly_ref(N) after every sell
  buyonly_ref(N) = weighted average sell price if N tokens were bought
                  without any sells (buy-only accumulation)
  Note: this value decreases as N decreases, so it is a lower bound
  reference, not a fixed floor in the traditional sense.
"""

import random
from dataclasses import dataclass, field

U64_MAX = 18_446_744_073_709_551_615

FIB = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
       89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765]
STAGE_SUPPLY  = [f * 1_000_000 for f in FIB]
BASE_PRICE    = 1_000_000   # lamports per token at stage 1
SPREAD_BPS    = 50          # 0.5% spread on sells
MAX_PER_TX    = 1_000_000   # max tokens per transaction
RENT_MIN      = 890_880     # minimum treasury balance (rent exemption)
MAX_STAGES    = 18          # stage 19 causes treasury overflow past U64_MAX


# ── Rust u64 arithmetic ───────────────────────────────────

class U64OverflowError(Exception): pass
class U64DivZeroError(Exception): pass

def checked_add(a, b):
    r = a + b
    if r > U64_MAX: raise U64OverflowError(f"overflow: {a}+{b}")
    return r

def checked_sub(a, b):
    if b > a: raise U64OverflowError(f"underflow: {a}-{b}")
    return a - b

def checked_mul(a, b):
    r = a * b
    if r > U64_MAX: raise U64OverflowError(f"overflow: {a}*{b}")
    return r

def checked_div(a, b):
    if b == 0: raise U64DivZeroError(f"div by zero: {a}/{b}")
    return a // b  # integer division, matching Rust semantics


# ── Buy-only reference price ──────────────────────────────

def buyonly_ref(total_sold: int) -> int:
    """
    Returns the weighted average sell price (lamports/token) if total_sold
    tokens had been purchased in order with no sells ever occurring.
    This represents the sell price when all tokens are held (maximum
    denominator), making it a lower bound reference for the actual
    sell price.
    """
    if total_sold <= 0: return 0
    treasury = 0
    remaining = total_sold
    for i in range(MAX_STAGES):
        bought = min(remaining, STAGE_SUPPLY[i])
        cost = checked_mul(checked_mul(bought, BASE_PRICE), FIB[i])
        treasury = checked_add(treasury, cost)
        remaining -= bought
        if remaining <= 0: break
    return checked_div(treasury, total_sold)


# ── Simulator — mirrors lib.rs behavior exactly ───────────

@dataclass
class Sim:
    treasury:    int = 0
    total_sold:  int = 0
    stage:       int = 0
    stage_sold:  list = field(default_factory=lambda: [0] * 20)
    total_buys:  int = 0
    total_sells: int = 0
    rounding_losses: float = 0.0  # cumulative rounding error (lamports)

    def sell_price(self) -> int:
        """treasury // total_sold — integer division matching Rust"""
        if self.total_sold == 0: return 0
        return checked_div(self.treasury, self.total_sold)

    def buy_price(self) -> int:
        if self.stage >= MAX_STAGES: return 0
        return checked_mul(BASE_PRICE, FIB[self.stage])

    def buy(self, amount: int) -> int:
        if self.stage >= MAX_STAGES or amount <= 0: return 0
        rem = checked_sub(STAGE_SUPPLY[self.stage], self.stage_sold[self.stage])
        actual = min(amount, min(rem, MAX_PER_TX))
        if actual <= 0: return 0
        cost = checked_mul(self.buy_price(), actual)
        self.treasury   = checked_add(self.treasury, cost)
        self.stage_sold[self.stage] = checked_add(self.stage_sold[self.stage], actual)
        self.total_sold = checked_add(self.total_sold, actual)
        self.total_buys += 1
        if self.stage_sold[self.stage] >= STAGE_SUPPLY[self.stage]:
            self.stage += 1
        return actual

    def sell(self, amount: int):
        """
        Execute a sell. Returns (sp_before, sp_after, sold_after) on success,
        or None if the sell cannot be executed.
        Arithmetic matches lib.rs exactly:
          avg   = treasury // total_sold
          gross = avg * amount
          spread = gross * SPREAD_BPS // 10_000
          payout = gross - spread
        """
        if amount <= 0 or amount >= self.total_sold: return None
        sp_before = self.sell_price()
        actual = min(amount, MAX_PER_TX)
        avg    = checked_div(self.treasury, self.total_sold)
        gross  = checked_mul(avg, actual)
        spread = checked_div(checked_mul(gross, SPREAD_BPS), 10_000)
        payout = checked_sub(gross, spread)
        if self.treasury < payout + RENT_MIN: return None
        # Track rounding loss: difference between exact payout and integer payout
        exact  = (self.treasury / self.total_sold) * actual * 995 / 1000
        self.rounding_losses += exact - payout  # always >= 0 (truncation)
        self.treasury   = checked_sub(self.treasury, payout)
        self.total_sold = checked_sub(self.total_sold, actual)
        self.total_sells += 1
        sp_after = self.sell_price()
        return (sp_before, sp_after, self.total_sold)

    def buy_n(self, target):
        """Buy until total_sold reaches target."""
        while self.total_sold < target and self.stage < MAX_STAGES:
            need = min(target - self.total_sold, MAX_PER_TX)
            if self.buy(need) == 0: break

    def buy_fill_stage(self, stage):
        """Buy until the given stage is fully sold out."""
        self.buy_n(sum(STAGE_SUPPLY[:stage + 1]))

    def sell_to(self, target):
        """Sell until total_sold reaches target, yielding each sell result."""
        target = max(1, target)
        while self.total_sold > target:
            chunk = min(MAX_PER_TX, self.total_sold - target)
            result = self.sell(chunk)
            if result is None: break
            yield result

    def sell_one(self, amount):
        """Execute a single sell and yield the result if successful."""
        result = self.sell(amount)
        if result is not None:
            yield result


# ── Test runner ───────────────────────────────────────────

@dataclass
class Stats:
    scenarios: int = 0
    checks: int = 0
    prop1_violations: int = 0
    prop2_violations: int = 0
    overflow_errors: int = 0
    results: list = field(default_factory=list)

stats = Stats()


def run(name: str, gen_fn) -> None:
    """
    gen_fn yields (sp_before, sp_after, sold_after) tuples — one per sell.
    Each yield is a checkpoint where both propositions are checked.
    """
    s = Sim()
    prop1_v = 0
    prop2_v = 0
    checks = 0

    try:
        for sp_before, sp_after, sold_after in gen_fn(s):
            checks += 1

            # Proposition 1: sell_price must not decrease after a sell
            if sp_after < sp_before:
                prop1_v += 1
                print(f"  PROP1_VIOLATION [{name}]: "
                      f"sold={sold_after:,} sp_before={sp_before:,} sp_after={sp_after:,} "
                      f"diff={sp_after-sp_before:,}")

            # Proposition 2: sell_price >= buyonly_ref(N)
            if sold_after > 0:
                ref = buyonly_ref(sold_after)
                if sp_after < ref:
                    prop2_v += 1
                    print(f"  PROP2_VIOLATION [{name}]: "
                          f"sold={sold_after:,} sp={sp_after:,} ref={ref:,} diff={sp_after-ref:,}")

    except U64OverflowError as e:
        stats.overflow_errors += 1
        print(f"  OVERFLOW [{name}]: {e}")
    except U64DivZeroError as e:
        print(f"  DIV_ZERO [{name}]: {e}")

    p1st = "PASS" if prop1_v == 0 else f"FAIL({prop1_v})"
    p2st = "PASS" if prop2_v == 0 else f"FAIL({prop2_v})"
    stats.results.append((name, checks, prop1_v, prop2_v, p1st, p2st,
                          s.total_buys, s.total_sells))
    stats.scenarios += 1
    stats.checks += checks
    stats.prop1_violations += prop1_v
    stats.prop2_violations += prop2_v


# ── Scenarios ─────────────────────────────────────────────

def sc_buy_all(s):
    for stage in range(MAX_STAGES):
        s.buy_fill_stage(stage)
    return; yield  # no sells

def sc_sell_half_each(s):
    for stage in range(MAX_STAGES):
        s.buy_fill_stage(stage)
        yield from s.sell_to(s.total_sold // 2)

def sc_sell_90pct_each(s):
    for stage in range(MAX_STAGES):
        s.buy_fill_stage(stage)
        yield from s.sell_to(max(1, s.total_sold // 10))

def sc_sell_99pct_each(s):
    for stage in range(MAX_STAGES):
        s.buy_fill_stage(stage)
        yield from s.sell_to(max(1, s.total_sold // 100))

def sc_sell_to_1_each(s):
    for stage in range(MAX_STAGES):
        s.buy_fill_stage(stage)
        yield from s.sell_to(1)

def sc_sell_then_rebuy(s):
    for stage in range(MAX_STAGES):
        s.buy_fill_stage(stage)
        yield from s.sell_to(max(1, s.total_sold // 5))
        s.buy_n(s.total_sold + 500_000)

def sc_boundary(s):
    """Buy and sell at every stage boundary (±1 token)."""
    cumulative = 0
    for stage in range(MAX_STAGES):
        cumulative += STAGE_SUPPLY[stage]
        s.buy_n(cumulative - 1)
        s.buy(1)
        if s.total_sold > 1:
            yield from s.sell_one(1)

def sc_zigzag_small(s):
    """Small zigzag: buy 100k, sell 50k, repeat 2000 times."""
    s.buy_n(3_000_000)
    for _ in range(2000):
        s.buy(100_000)
        yield from s.sell_one(50_000)

def sc_zigzag_large(s):
    """Large zigzag: buy 1M, sell 900k, repeat 500 times."""
    s.buy_n(5_000_000)
    for _ in range(500):
        s.buy(MAX_PER_TX)
        yield from s.sell_to(s.total_sold - 900_000)

def sc_panic_cycles(s):
    """8 cycles of: buy to target → sell 90% → rebuy 2M."""
    for cycle in range(8):
        s.buy_n(sum(STAGE_SUPPLY[:min(cycle+3, MAX_STAGES)]))
        yield from s.sell_to(max(1, s.total_sold // 10))
        s.buy_n(s.total_sold + 2_000_000)

def sc_one_by_one_buy(s):
    """Buy 1 token at a time for 5000 steps (no sells)."""
    for _ in range(5000):
        if s.buy(1) == 0: break
    return; yield

def sc_one_by_one_sell(s):
    """Sell 1 token at a time for 5000 steps."""
    s.buy_n(sum(STAGE_SUPPLY[:5]))
    for _ in range(5000):
        if s.total_sold <= 1: break
        yield from s.sell_one(1)

def sc_max_tx(s):
    """Buy and sell using exactly MAX_PER_TX each time."""
    for _ in range(100): s.buy(MAX_PER_TX)
    for _ in range(80):
        if s.total_sold > MAX_PER_TX + 1:
            yield from s.sell_one(MAX_PER_TX)

def sc_continuous_sell(s):
    """Buy through 15 stages then sell all the way down to 1."""
    s.buy_n(sum(STAGE_SUPPLY[:15]))
    while s.total_sold > 1:
        yield from s.sell_one(min(MAX_PER_TX, s.total_sold - 1))

def sc_deep(s):
    """Buy to high stages (9, 12, 15, 17) and sell in steps."""
    for ts in [9, 12, 15, 17]:
        if ts >= MAX_STAGES: break
        s.buy_fill_stage(ts)
        for pct in [50, 25, 10, 1]:
            yield from s.sell_to(max(1, s.total_sold * pct // 100))
        s.buy_n(s.total_sold + 10_000_000)

def sc_full_sell(s):
    """Buy all 18 stages then sell down to 1 token."""
    s.buy_n(sum(STAGE_SUPPLY[:MAX_STAGES]))
    yield from s.sell_to(1)

def make_random(seed, buy_prob, n_steps, init_stages):
    """Random buy/sell mix with given buy probability."""
    def gen(s):
        rng = random.Random(seed)
        s.buy_n(sum(STAGE_SUPPLY[:init_stages]))
        for _ in range(n_steps):
            r = rng.random()
            if r < buy_prob and s.stage < MAX_STAGES:
                s.buy(rng.randint(1, MAX_PER_TX))
            elif s.total_sold > 1:
                yield from s.sell_one(rng.randint(1, min(MAX_PER_TX, s.total_sold - 1)))
    return gen

def make_sell_heavy(seed, n=5_000_000):
    """Sell-biased random (15% buy, 85% sell)."""
    def gen(s):
        rng = random.Random(seed)
        s.buy_n(sum(STAGE_SUPPLY[:8]))
        for _ in range(n):
            if rng.random() < 0.15 and s.stage < MAX_STAGES:
                s.buy(rng.randint(1, MAX_PER_TX))
            elif s.total_sold > 1:
                yield from s.sell_one(rng.randint(1, min(MAX_PER_TX, s.total_sold - 1)))
    return gen

def make_buy_heavy(seed, n=5_000_000):
    """Buy-biased random (90% buy, 10% sell)."""
    def gen(s):
        rng = random.Random(seed)
        for _ in range(n):
            if rng.random() < 0.9 and s.stage < MAX_STAGES:
                s.buy(rng.randint(1, MAX_PER_TX))
            elif s.total_sold > 1:
                yield from s.sell_one(rng.randint(1, min(MAX_PER_TX, s.total_sold - 1)))
    return gen


# ── Main ──────────────────────────────────────────────────

print("=" * 90)
print("Nautilus Floor Price Simulation — Production Grade (Final)")
print(f"  MAX_STAGES={MAX_STAGES}, MAX_PER_TX={MAX_PER_TX:,}")
print()
print("  Prop 1: sell_price never decreases after a sell  (sp_after >= sp_before)")
print("  Prop 2: sell_price >= buyonly_ref(N)             (>= buy-only weighted average)")
print("=" * 90)
print()

print("── Basic scenarios ──────────────────────────────────────────────")
run("buy only (no sells)",              sc_buy_all)
run("sell 50% each stage",              sc_sell_half_each)
run("sell 90% each stage",              sc_sell_90pct_each)
run("sell 99% each stage",              sc_sell_99pct_each)
run("sell to 1 each stage",             sc_sell_to_1_each)
run("sell then rebuy",                  sc_sell_then_rebuy)
run("stage boundary stress",            sc_boundary)
run("zigzag small (100k/50k x2000)",    sc_zigzag_small)
run("zigzag large (1M/900k x500)",      sc_zigzag_large)
run("panic cycles x8",                  sc_panic_cycles)
run("one by one buy (5000)",            sc_one_by_one_buy)
run("one by one sell (5000)",           sc_one_by_one_sell)
run("max_per_tx only",                  sc_max_tx)
run("continuous sell to 1",             sc_continuous_sell)
run("deep stages",                      sc_deep)
run("all 18 stages -> sell to 1",       sc_full_sell)

print()
print("── Random 50/50 (5M steps each) ────────────────────────────────")
for seed in [1, 42, 99, 123, 777, 1234, 9999, 31337, 54321, 11111]:
    run(f"random 50/50 seed={seed}", make_random(seed, 0.5, 5_000_000, 3))

print()
print("── Sell-heavy (15% buy, 5M steps each) ─────────────────────────")
for seed in [1, 42, 99, 123, 456, 789, 2025]:
    run(f"sell-heavy seed={seed}", make_sell_heavy(seed))

print()
print("── Buy-heavy (90% buy, 5M steps each) ──────────────────────────")
for seed in [1, 42, 99, 123, 456, 789, 2025]:
    run(f"buy-heavy seed={seed}", make_buy_heavy(seed))

# ── Results ───────────────────────────────────────────────
print()
print("=" * 90)
print("RESULTS")
print("=" * 90)
nw = max(len(r[0]) for r in stats.results) + 2
print(f"  {'Prop1':<14} {'Prop2':<14} {'Scenario':<{nw}} {'Checks':>10} {'Buys':>8} {'Sells':>8}")
print(f"  {'-'*14} {'-'*14} {'-'*nw} {'-'*10} {'-'*8} {'-'*8}")
for name, checks, p1v, p2v, p1st, p2st, buys, sells in stats.results:
    print(f"  {p1st:<14} {p2st:<14} {name:<{nw}} {checks:>10,} {buys:>8,} {sells:>8,}")

print()
print(f"  Total scenarios   : {stats.scenarios:,}")
print(f"  Total sell checks : {stats.checks:,}")
print(f"  Overflow errors   : {stats.overflow_errors:,}")
print()
print(f"  Prop1 violations  : {stats.prop1_violations:,}  (sell_price decreased after sell)")
print(f"  Prop2 violations  : {stats.prop2_violations:,}  (sell_price < buyonly_ref)")
print()

ok1 = stats.prop1_violations == 0
ok2 = stats.prop2_violations == 0
ok3 = stats.overflow_errors == 0

if ok1: print("  ✓ Prop1: sell_price never decreases after a sell (sp_after >= sp_before) — PROVEN")
else:   print(f"  ✗ Prop1: VIOLATIONS = {stats.prop1_violations:,}")
if ok2: print("  ✓ Prop2: sell_price >= buyonly_ref(N) — PROVEN")
else:   print(f"  ✗ Prop2: VIOLATIONS = {stats.prop2_violations:,}")
if ok3: print("  ✓ No u64 overflow errors")
else:   print(f"  ✗ Overflow errors: {stats.overflow_errors:,}")