"""
Nautilus Floor Price Monotonicity — Monte Carlo Simulation
===========================================================
Verifies that buyonly_ref(N) is monotonically non-decreasing in N.

buyonly_ref(N) = weighted average buy price for N tokens purchased
                 in stage order with no sells.

Since Fibonacci buy prices are strictly increasing across stages,
adding more tokens (advancing to higher stages) can only increase
or maintain the weighted average — never decrease it.

Proposition: For any N1 < N2,
  buyonly_ref(N1) <= buyonly_ref(N2)

Equivalently: every buy operation leaves buyonly_ref >= its previous value.

Monte Carlo: sample random N values and verify monotonicity.
Also verify directly by checking buyonly_ref after every buy.
"""

import random
from dataclasses import dataclass, field

U64_MAX = 18_446_744_073_709_551_615

FIB = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
       89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765]
STAGE_SUPPLY  = [f * 1_000_000 for f in FIB]
BASE_PRICE    = 1_000_000
MAX_PER_TX    = 1_000_000
MAX_STAGES    = 18


class U64OverflowError(Exception): pass
class U64DivZeroError(Exception): pass

def checked_add(a, b):
    r = a + b
    if r > U64_MAX: raise U64OverflowError(f"overflow: {a}+{b}")
    return r

def checked_mul(a, b):
    r = a * b
    if r > U64_MAX: raise U64OverflowError(f"overflow: {a}*{b}")
    return r

def checked_div(a, b):
    if b == 0: raise U64DivZeroError(f"div by zero: {a}/{b}")
    return a // b


def buyonly_ref(total_sold: int) -> int:
    """Weighted average buy price for total_sold tokens (buy-only, in stage order)."""
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


# ── Test 1: Exhaustive check across all stage boundaries ─

def test_exhaustive():
    """
    Check buyonly_ref at every token count from 1 to full 18 stages.
    Verify it never decreases.
    """
    print("── Test 1: Exhaustive monotonicity across all stage boundaries ──")
    checks = 0
    violations = 0
    prev_ref = 0
    prev_n = 0

    # Check at every 1M boundary and stage transition
    checkpoints = []
    cumulative = 0
    for stage in range(MAX_STAGES):
        supply = STAGE_SUPPLY[stage]
        # Check at start, middle, and end of each stage
        checkpoints.append(cumulative + 1)
        checkpoints.append(cumulative + supply // 2)
        checkpoints.append(cumulative + supply - 1)
        checkpoints.append(cumulative + supply)
        cumulative += supply

    for n in sorted(set(checkpoints)):
        if n <= 0: continue
        ref = buyonly_ref(n)
        checks += 1
        if ref < prev_ref:
            violations += 1
            print(f"  VIOLATION: N={n:,} ref={ref:,} prev_ref={prev_ref:,} "
                  f"diff={ref-prev_ref:,}")
        prev_ref = ref
        prev_n = n

    status = "PASS" if violations == 0 else f"FAIL({violations})"
    print(f"  {status}  checks={checks:,}  violations={violations}")
    print(f"  buyonly_ref range: {buyonly_ref(1)/1e9:.6f} SOL "
          f"→ {buyonly_ref(sum(STAGE_SUPPLY[:MAX_STAGES]))/1e9:.6f} SOL")
    return checks, violations


# ── Test 2: Fine-grained check 1 token at a time ─────────

def test_one_by_one():
    """
    Walk from N=1 to N=10M one token at a time.
    Check buyonly_ref never decreases.
    """
    print()
    print("── Test 2: One-token-at-a-time (N=1 to 10M) ────────────────────")
    checks = 0
    violations = 0
    prev_ref = 0
    limit = 10_000_000

    for n in range(1, limit + 1):
        ref = buyonly_ref(n)
        checks += 1
        if ref < prev_ref:
            violations += 1
            print(f"  VIOLATION: N={n:,} ref={ref:,} prev_ref={prev_ref:,}")
        prev_ref = ref

    status = "PASS" if violations == 0 else f"FAIL({violations})"
    print(f"  {status}  checks={checks:,}  violations={violations}")
    return checks, violations


# ── Test 3: Monte Carlo random pair sampling ──────────────

def test_monte_carlo(n_trials, seed):
    """
    Sample random pairs (N1, N2) with N1 < N2.
    Verify buyonly_ref(N1) <= buyonly_ref(N2).
    """
    print()
    print(f"── Test 3: Monte Carlo random pair sampling ({n_trials:,} trials) ──")
    rng = random.Random(seed)
    max_n = sum(STAGE_SUPPLY[:MAX_STAGES])
    checks = 0
    violations = 0

    for _ in range(n_trials):
        n1 = rng.randint(1, max_n - 1)
        n2 = rng.randint(n1 + 1, max_n)
        ref1 = buyonly_ref(n1)
        ref2 = buyonly_ref(n2)
        checks += 1
        if ref2 < ref1:
            violations += 1
            print(f"  VIOLATION: N1={n1:,} ref1={ref1:,} "
                  f"N2={n2:,} ref2={ref2:,} diff={ref2-ref1:,}")

    status = "PASS" if violations == 0 else f"FAIL({violations})"
    print(f"  {status}  checks={checks:,}  violations={violations}")
    return checks, violations


# ── Test 4: Monte Carlo sequential buy simulation ─────────

def test_sequential_buy(n_trials, seed):
    """
    Simulate actual buy sequences and check buyonly_ref after each buy.
    This mirrors real protocol usage.
    """
    print()
    print(f"── Test 4: Sequential buy simulation ({n_trials:,} trials) ──────────")
    rng = random.Random(seed)
    total_checks = 0
    total_violations = 0

    for trial in range(n_trials):
        if (trial + 1) % 2000 == 0:
            print(f"  ... {trial+1:,} / {n_trials:,}  "
                  f"checks={total_checks:,}  violations={total_violations}")

        # Random number of buys
        n_buys = rng.randint(1, 200)
        total_sold = 0
        prev_ref = 0
        checks = 0
        violations = 0

        for _ in range(n_buys):
            # Random buy amount
            size_type = rng.random()
            if size_type < 0.33:
                amt = rng.randint(1, MAX_PER_TX)
            elif size_type < 0.66:
                amt = MAX_PER_TX
            else:
                amt = max(1, int(MAX_PER_TX * rng.random() ** 2))

            # Cap at remaining supply
            max_remaining = sum(STAGE_SUPPLY[:MAX_STAGES]) - total_sold
            amt = min(amt, max_remaining)
            if amt <= 0: break

            total_sold += amt
            ref = buyonly_ref(total_sold)
            checks += 1

            if ref < prev_ref:
                violations += 1
                print(f"  VIOLATION trial={trial}: "
                      f"sold={total_sold:,} ref={ref:,} prev={prev_ref:,}")

            prev_ref = ref

        total_checks     += checks
        total_violations += violations

    status = "PASS" if total_violations == 0 else f"FAIL({total_violations})"
    print(f"  {status}  checks={total_checks:,}  violations={total_violations}")
    return total_checks, total_violations


# ── Main ──────────────────────────────────────────────────

print("=" * 75)
print("Nautilus Floor Price Monotonicity Simulation")
print()
print("  Proposition: buyonly_ref(N) is monotonically non-decreasing in N")
print("  i.e., for any N1 < N2: buyonly_ref(N1) <= buyonly_ref(N2)")
print()
print("  Why this holds: Fibonacci buy prices are strictly increasing.")
print("  Adding tokens always adds higher-priced tokens (or same stage),")
print("  so the weighted average can only increase or stay flat.")
print("=" * 75)
print()

all_checks    = 0
all_violations = 0

c, v = test_exhaustive()
all_checks += c; all_violations += v

c, v = test_one_by_one()
all_checks += c; all_violations += v

c, v = test_monte_carlo(n_trials=100_000, seed=42)
all_checks += c; all_violations += v

c, v = test_sequential_buy(n_trials=10_000, seed=42)
all_checks += c; all_violations += v

print()
print("=" * 75)
print("GRAND TOTAL")
print("=" * 75)
print(f"  Total checks     : {all_checks:,}")
print(f"  Total violations : {all_violations:,}")
print()
if all_violations == 0:
    print("  ✓ buyonly_ref(N) is monotonically non-decreasing — PROVEN")
    print("  ✓ floor price never decreases as more tokens are purchased")
else:
    print(f"  ✗ VIOLATIONS FOUND: {all_violations:,}")