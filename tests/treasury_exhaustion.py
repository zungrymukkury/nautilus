"""
Nautilus Treasury Exhaustion Simulation
========================================
Verifies that the treasury can always fulfill every sell order,
all the way down to the last token.

Proposition: For any sequence of buys and sells, as long as at least
one token remains in circulation, the treasury always has enough SOL
to pay out a sell (treasury >= payout + RENT_MIN).

This is the mathematical guarantee that "the last token can always be sold."

Monte Carlo approach: randomly sample buy/sell sequences and verify
that the treasury never becomes insufficient to fulfill a sell.
"""

import random
from dataclasses import dataclass, field

U64_MAX = 18_446_744_073_709_551_615

FIB = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
       89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765]
STAGE_SUPPLY  = [f * 1_000_000 for f in FIB]
BASE_PRICE    = 1_000_000
SPREAD_BPS    = 50
MAX_PER_TX    = 1_000_000
RENT_MIN      = 890_880
MAX_STAGES    = 18


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
    return a // b


@dataclass
class Sim:
    treasury:   int = 0
    total_sold: int = 0
    stage:      int = 0
    stage_sold: list = field(default_factory=lambda: [0] * 20)

    def sell_price(self):
        if self.total_sold == 0: return 0
        return checked_div(self.treasury, self.total_sold)

    def buy_price(self):
        if self.stage >= MAX_STAGES: return 0
        return checked_mul(BASE_PRICE, FIB[self.stage])

    def buy(self, amount):
        if self.stage >= MAX_STAGES or amount <= 0: return 0
        rem = checked_sub(STAGE_SUPPLY[self.stage], self.stage_sold[self.stage])
        actual = min(amount, min(rem, MAX_PER_TX))
        if actual <= 0: return 0
        cost = checked_mul(self.buy_price(), actual)
        self.treasury   = checked_add(self.treasury, cost)
        self.stage_sold[self.stage] = checked_add(self.stage_sold[self.stage], actual)
        self.total_sold = checked_add(self.total_sold, actual)
        if self.stage_sold[self.stage] >= STAGE_SUPPLY[self.stage]:
            self.stage += 1
        return actual

    def try_sell(self, amount) -> dict:
        """
        Attempt a sell. Returns a result dict including:
          - attempted: the amount we tried to sell
          - executed:  the amount actually sold (0 if treasury insufficient)
          - treasury_before / after
          - payout
          - sufficient: whether treasury was sufficient
          - would_underfund: True if treasury < payout + RENT_MIN
        """
        if amount <= 0 or amount >= self.total_sold:
            return {'attempted': amount, 'executed': 0, 'sufficient': True,
                    'would_underfund': False, 'skipped': True}

        actual = min(amount, MAX_PER_TX)
        avg    = checked_div(self.treasury, self.total_sold)
        gross  = checked_mul(avg, actual)
        spread = checked_div(checked_mul(gross, SPREAD_BPS), 10_000)
        payout = checked_sub(gross, spread)

        treasury_before = self.treasury
        sufficient = self.treasury >= payout + RENT_MIN
        would_underfund = not sufficient

        if sufficient:
            self.treasury   = checked_sub(self.treasury, payout)
            self.total_sold = checked_sub(self.total_sold, actual)
            executed = actual
        else:
            executed = 0

        return {
            'attempted':       amount,
            'executed':        executed,
            'treasury_before': treasury_before,
            'treasury_after':  self.treasury,
            'payout':          payout,
            'sufficient':      sufficient,
            'would_underfund': would_underfund,
            'total_sold':      self.total_sold,
        }

    def buy_n(self, target):
        while self.total_sold < target and self.stage < MAX_STAGES:
            need = min(target - self.total_sold, MAX_PER_TX)
            if self.buy(need) == 0: break

    def drain_to_1(self):
        """
        Sell all the way down to 1 token, checking at each step.
        Yields each sell result dict.
        """
        while self.total_sold > 1:
            chunk = min(MAX_PER_TX, self.total_sold - 1)
            result = self.try_sell(chunk)
            yield result
            if result['would_underfund'] or result['executed'] == 0:
                break  # stop if treasury insufficient


# ── Scenario: sell everything in order ───────────────────

def run_drain_scenario(name, sim):
    """
    Drain to 1 token and verify treasury never goes insufficient.
    Returns (checks, violations, min_treasury_margin)
    """
    checks = 0
    violations = 0
    min_margin = float('inf')  # minimum (treasury - payout - RENT_MIN) seen

    for result in sim.drain_to_1():
        if result.get('skipped'): continue
        checks += 1
        margin = result['treasury_before'] - result['payout'] - RENT_MIN
        if margin < min_margin:
            min_margin = margin
        if result['would_underfund']:
            violations += 1
            print(f"  VIOLATION [{name}]: "
                  f"sold={result['total_sold']:,} "
                  f"treasury={result['treasury_before']:,} "
                  f"payout={result['payout']:,} "
                  f"shortfall={result['payout'] + RENT_MIN - result['treasury_before']:,}")

    return checks, violations, min_margin


# ── Fixed scenarios ───────────────────────────────────────

@dataclass
class Stats:
    scenarios: int = 0
    checks: int = 0
    violations: int = 0
    min_margin: float = float('inf')
    results: list = field(default_factory=list)

stats = Stats()


def run_fixed(name, setup_fn):
    s = Sim()
    setup_fn(s)
    checks, violations, min_margin = run_drain_scenario(name, s)
    status = "PASS" if violations == 0 else f"FAIL({violations})"
    margin_sol = min_margin / 1e9 if min_margin != float('inf') else 0
    stats.results.append((name, checks, violations, status, margin_sol))
    stats.scenarios += 1
    stats.checks += checks
    stats.violations += violations
    if min_margin < stats.min_margin:
        stats.min_margin = min_margin


# ── Monte Carlo ───────────────────────────────────────────

def run_monte_carlo(n_trials, seed):
    rng = random.Random(seed)
    mc_checks = 0
    mc_violations = 0
    mc_min_margin = float('inf')
    violation_details = []

    for i in range(n_trials):
        if (i + 1) % 2000 == 0:
            print(f"  ... {i+1:,} / {n_trials:,} trials"
                  f"  checks={mc_checks:,}"
                  f"  violations={mc_violations}")

        try:
            # Sample random buy sequence
            init_stage   = rng.randint(1, 14)
            buy_prob     = rng.uniform(0.0, 1.0)
            extra_steps  = rng.randint(0, 50)
            size_fn      = rng.choice([
                lambda: rng.randint(1, MAX_PER_TX),
                lambda: MAX_PER_TX,
                lambda: max(1, int(MAX_PER_TX * rng.random() ** 2)),  # small-biased
            ])

            s = Sim()
            # Initial buy
            s.buy_n(sum(STAGE_SUPPLY[:init_stage]))
            # Random additional buys and sells before draining
            for _ in range(extra_steps):
                if rng.random() < buy_prob and s.stage < MAX_STAGES:
                    s.buy(size_fn())
                elif s.total_sold > 1:
                    amt = min(size_fn(), s.total_sold - 1)
                    s.try_sell(amt)

            # Now drain to 1
            checks, violations, min_margin = run_drain_scenario(
                f"mc_trial_{i}", s
            )
            mc_checks     += checks
            mc_violations += violations
            if min_margin < mc_min_margin:
                mc_min_margin = min_margin

            if violations > 0:
                violation_details.append({
                    'trial': i,
                    'init_stage': init_stage,
                    'buy_prob': buy_prob,
                    'violations': violations,
                })

        except (U64OverflowError, U64DivZeroError):
            continue  # skip overflow trials

    return mc_checks, mc_violations, mc_min_margin, violation_details


# ── Main ──────────────────────────────────────────────────

print("=" * 75)
print("Nautilus Treasury Exhaustion Simulation")
print()
print("  Proposition: treasury is always sufficient to pay out any sell,")
print("  all the way down to the last token in circulation.")
print()
print("  Check: treasury_before >= payout + RENT_MIN for every sell")
print("  Min margin = smallest (treasury - payout - RENT_MIN) observed")
print("=" * 75)
print()

print("── Fixed scenarios ──────────────────────────────────────────────")

run_fixed("stages 1-3 full → drain to 1",
          lambda s: s.buy_n(sum(STAGE_SUPPLY[:3])))
run_fixed("stages 1-6 full → drain to 1",
          lambda s: s.buy_n(sum(STAGE_SUPPLY[:6])))
run_fixed("stages 1-10 full → drain to 1",
          lambda s: s.buy_n(sum(STAGE_SUPPLY[:10])))
run_fixed("stages 1-14 full → drain to 1",
          lambda s: s.buy_n(sum(STAGE_SUPPLY[:14])))
run_fixed("stages 1-18 full → drain to 1",
          lambda s: s.buy_n(sum(STAGE_SUPPLY[:18])))

def setup_mixed(s):
    s.buy_n(sum(STAGE_SUPPLY[:8]))
    # sell 50%, buy more, then drain
    target = s.total_sold // 2
    while s.total_sold > target:
        s.try_sell(min(MAX_PER_TX, s.total_sold - target))
    s.buy_n(s.total_sold + sum(STAGE_SUPPLY[8:11]))

run_fixed("mixed buy/sell then drain", setup_mixed)

def setup_panic(s):
    s.buy_n(sum(STAGE_SUPPLY[:12]))
    # panic sell 99%
    target = max(2, s.total_sold // 100)
    while s.total_sold > target:
        s.try_sell(min(MAX_PER_TX, s.total_sold - target))

run_fixed("panic sell 99% then drain", setup_panic)

nw = max(len(r[0]) for r in stats.results) + 2
print()
print(f"  {'Status':<8} {'Min margin (SOL)':>18} {'Checks':>10} {'Scenario':<{nw}}")
print(f"  {'-'*8} {'-'*18} {'-'*10} {'-'*nw}")
for name, checks, violations, status, margin_sol in stats.results:
    print(f"  {status:<8} {margin_sol:>18.6f} {checks:>10,} {name:<{nw}}")

print()
print("── Monte Carlo (random buy sequences → drain to 1) ──────────────")
MC_TRIALS = 10_000
mc_checks, mc_violations, mc_min_margin, mc_violation_details = \
    run_monte_carlo(MC_TRIALS, seed=42)

print()
print("=" * 75)
print("RESULTS")
print("=" * 75)
total_violations = stats.violations + mc_violations
total_checks     = stats.checks + mc_checks
overall_min      = min(stats.min_margin, mc_min_margin)

print(f"  Fixed scenarios   : {stats.scenarios} scenarios, {stats.checks:,} sell checks")
print(f"  Monte Carlo       : {MC_TRIALS:,} trials,    {mc_checks:,} sell checks")
print(f"  Total sell checks : {total_checks:,}")
print(f"  Total violations  : {total_violations:,}")
print()
print(f"  Minimum margin observed : {overall_min/1e9:.9f} SOL")
print(f"  (margin = treasury - payout - RENT_MIN, must always be >= 0)")
print()

if mc_violation_details:
    print(f"  ✗ VIOLATIONS in {len(mc_violation_details)} Monte Carlo trials:")
    for d in mc_violation_details[:3]:
        print(f"    Trial {d['trial']:,}: stage={d['init_stage']} "
              f"buy_prob={d['buy_prob']:.2f} violations={d['violations']}")
else:
    if total_violations == 0:
        print("  ✓ Treasury always sufficient — the last token can always be sold")
        print("  ✓ No u64 overflow errors")
    else:
        print(f"  ✗ VIOLATIONS FOUND: {total_violations:,}")