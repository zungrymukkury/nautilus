"""
Nautilus Floor Price — Monte Carlo Simulation
==============================================
All parameters are sampled from probability distributions each trial.
Searches for any violation of:

  Prop 1: sell_price never decreases after a sell
  Prop 2: sell_price >= buyonly_ref(N)

Monte Carlo parameters sampled per trial:
  - buy probability       : Uniform(0.0, 1.0)
  - initial stage         : Uniform(1, 12)
  - number of steps       : LogUniform(100, 500_000)
  - trade size distribution: one of [uniform, power-law, fixed-max]
  - panic event           : with 20% probability, sell 90%+ mid-run
"""

import random
import math
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


def buyonly_ref(total_sold: int) -> int:
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


@dataclass
class Sim:
    treasury:    int = 0
    total_sold:  int = 0
    stage:       int = 0
    stage_sold:  list = field(default_factory=lambda: [0] * 20)

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

    def sell(self, amount):
        """Returns (sp_before, sp_after, sold_after) or None."""
        if amount <= 0 or amount >= self.total_sold: return None
        sp_before = self.sell_price()
        actual = min(amount, MAX_PER_TX)
        avg    = checked_div(self.treasury, self.total_sold)
        gross  = checked_mul(avg, actual)
        spread = checked_div(checked_mul(gross, SPREAD_BPS), 10_000)
        payout = checked_sub(gross, spread)
        if self.treasury < payout + RENT_MIN: return None
        self.treasury   = checked_sub(self.treasury, payout)
        self.total_sold = checked_sub(self.total_sold, actual)
        return (sp_before, self.sell_price(), self.total_sold)

    def buy_n(self, target):
        while self.total_sold < target and self.stage < MAX_STAGES:
            need = min(target - self.total_sold, MAX_PER_TX)
            if self.buy(need) == 0: break

    def sell_to(self, target):
        target = max(1, target)
        while self.total_sold > target:
            chunk = min(MAX_PER_TX, self.total_sold - target)
            result = self.sell(chunk)
            if result is None: break
            yield result


# ── Trade size samplers ───────────────────────────────────

def sample_uniform(rng):
    return rng.randint(1, MAX_PER_TX)

def sample_power_law(rng):
    """Power-law: many small trades, few large ones."""
    u = rng.random()
    # P(X > x) = (1/x)^alpha, alpha=1.5
    return max(1, min(MAX_PER_TX, int(MAX_PER_TX * (u ** -0.67))))

def sample_fixed_max(rng):
    return MAX_PER_TX

SIZE_SAMPLERS = [sample_uniform, sample_power_law, sample_fixed_max]


# ── Single trial ──────────────────────────────────────────

def run_trial(rng) -> dict:
    """
    Run one Monte Carlo trial with randomly sampled parameters.
    Returns a dict with trial params and results.
    """
    # Sample parameters
    buy_prob      = rng.uniform(0.0, 1.0)
    init_stage    = rng.randint(1, 12)
    n_steps       = int(10 ** rng.uniform(2, 5.7))  # 100 to ~500k
    size_sampler  = rng.choice(SIZE_SAMPLERS)
    panic_enabled = rng.random() < 0.2
    panic_at      = rng.randint(n_steps // 4, 3 * n_steps // 4) if panic_enabled else -1
    panic_pct     = rng.uniform(0.85, 0.999) if panic_enabled else 0

    s = Sim()
    s.buy_n(sum(STAGE_SUPPLY[:init_stage]))

    prop1_v = 0
    prop2_v = 0
    checks  = 0

    for step in range(n_steps):
        # Panic event
        if step == panic_at and s.total_sold > 1:
            target = max(1, int(s.total_sold * (1 - panic_pct)))
            for result in s.sell_to(target):
                checks += 1
                sp_before, sp_after, sold_after = result
                if sp_after < sp_before: prop1_v += 1
                if sold_after > 0 and sp_after < buyonly_ref(sold_after): prop2_v += 1

        r = rng.random()
        if r < buy_prob and s.stage < MAX_STAGES:
            s.buy(size_sampler(rng))
        elif s.total_sold > 1:
            amt = min(size_sampler(rng), s.total_sold - 1)
            result = s.sell(amt)
            if result is not None:
                checks += 1
                sp_before, sp_after, sold_after = result
                if sp_after < sp_before: prop1_v += 1
                if sold_after > 0 and sp_after < buyonly_ref(sold_after): prop2_v += 1

    return {
        'buy_prob':   buy_prob,
        'init_stage': init_stage,
        'n_steps':    n_steps,
        'size_dist':  size_sampler.__name__,
        'panic':      panic_enabled,
        'checks':     checks,
        'prop1_v':    prop1_v,
        'prop2_v':    prop2_v,
    }


# ── Main ──────────────────────────────────────────────────

N_TRIALS    = 10_000
MASTER_SEED = 42

print("=" * 75)
print("Nautilus Floor Price — Monte Carlo Simulation")
print(f"  Trials      : {N_TRIALS:,}")
print(f"  Master seed : {MASTER_SEED}")
print()
print("  Parameters sampled per trial:")
print("    buy_prob    ~ Uniform(0, 1)")
print("    init_stage  ~ Uniform(1, 12)")
print("    n_steps     ~ LogUniform(100, 500k)")
print("    size_dist   ~ {uniform, power_law, fixed_max}")
print("    panic event ~ 20% probability, sell 85-99.9%")
print()
print("  Propositions checked on every sell:")
print("    Prop1: sp_after >= sp_before")
print("    Prop2: sp_after >= buyonly_ref(N)")
print("=" * 75)

rng = random.Random(MASTER_SEED)

total_checks = 0
total_prop1  = 0
total_prop2  = 0
overflow_err = 0
violations   = []  # (trial_idx, result) for any violation

for i in range(N_TRIALS):
    if (i + 1) % 1000 == 0:
        print(f"  ... {i+1:,} / {N_TRIALS:,} trials"
              f"  checks={total_checks:,}"
              f"  violations={total_prop1+total_prop2}")

    try:
        result = run_trial(rng)
    except (U64OverflowError, U64DivZeroError):
        overflow_err += 1
        continue

    total_checks += result['checks']
    total_prop1  += result['prop1_v']
    total_prop2  += result['prop2_v']

    if result['prop1_v'] > 0 or result['prop2_v'] > 0:
        violations.append((i, result))

# ── Results ───────────────────────────────────────────────

print()
print("=" * 75)
print("RESULTS")
print("=" * 75)
print(f"  Trials completed  : {N_TRIALS:,}")
print(f"  Total sell checks : {total_checks:,}")
print(f"  Overflow errors   : {overflow_err:,}")
print()
print(f"  Prop1 violations  : {total_prop1:,}  (sp decreased after sell)")
print(f"  Prop2 violations  : {total_prop2:,}  (sp < buyonly_ref)")
print()

if violations:
    print(f"  ✗ VIOLATIONS FOUND in {len(violations)} trials:")
    for trial_idx, r in violations[:5]:
        print(f"    Trial {trial_idx:,}: buy_prob={r['buy_prob']:.2f} "
              f"stage={r['init_stage']} steps={r['n_steps']:,} "
              f"dist={r['size_dist']} panic={r['panic']}")
        print(f"      prop1={r['prop1_v']} prop2={r['prop2_v']}")
else:
    print("  ✓ Prop1: sell_price never decreases after a sell — NO VIOLATIONS")
    print("  ✓ Prop2: sell_price >= buyonly_ref(N) — NO VIOLATIONS")

if overflow_err == 0:
    print("  ✓ No u64 overflow errors")
else:
    print(f"  ✗ Overflow errors: {overflow_err}")

print()
print(f"  Avg checks per trial : {total_checks // N_TRIALS:,}")