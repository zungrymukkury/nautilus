#!/usr/bin/env python3
"""
Nautilus Protocol - Automated Security Check
Trail of Bits / Neodyme / SlowMist / Zealynx / Cantina / Sealevel Attacks
"""

import os
import sys
import json
import urllib.request

def call_claude(prompt: str, code: str, cargo: str = "") -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    content = f"{prompt}\n\n```rust\n{code}\n```"
    if cargo:
        content += f"\n\n```toml\n{cargo}\n```"

    payload = {
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 4000,
        "messages": [
            {
                "role": "user",
                "content": content
            }
        ]
    }

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01"
        }
    )

    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        return data["content"][0]["text"]


PROMPT = """
You are a Solana smart contract security auditor specializing in Anchor programs.

IMPORTANT: This program uses the Anchor framework. When evaluating security checks, you MUST account for Anchor's built-in protections:
- Anchor's `init` constraint automatically prevents double-initialization by checking account discriminators
- Anchor automatically detects and rejects duplicate mutable accounts within the same transaction
- `Account<'info, T>` wrappers automatically validate account ownership
- `Program<'info, T>` accounts enforce program ID validation
- `Signer<'info>` enforces signature verification
- Seeds/bump constraints enforce PDA derivation

Do NOT flag "mint authority could mint unlimited tokens" as a WARNING — the mint authority is a PDA (no private key exists) and can only be invoked by the program itself through CPI with signer seeds. This is by design and is not a vulnerability.
Do NOT flag dependency version warnings if no specific CVE exists for the listed version — if the version is recent and no CVE is known, mark PASS.
Do NOT flag division-by-zero risks where checked_div is already used and upstream require! guards prevent zero denominators.
Do NOT flag issues that are already handled by Anchor's framework unless the protection is explicitly bypassed.

Analyze the following Anchor/Rust program against ALL of these checklists.
A Cargo.toml is also provided for dependency vulnerability checks.

## Trail of Bits (6 items)
1. Arbitrary CPI - unchecked program IDs in CPI calls
2. Improper PDA Validation - not using canonical bump
3. Missing Ownership Check - deserializing without owner validation
4. Missing Signer Check - authority operations without is_signer
5. Sysvar Account Spoofing - accepting sysvar from user input
6. Improper Instruction Introspection - absolute indexes

## Neodyme (3 items)
7. Account Confusions - same data structure used for different account types
8. PDA Seed Collision - different roles sharing same seeds
9. Reentrancy - external calls before state updates

## SlowMist (2 items)
10. Integer Overflow/Underflow - missing checked arithmetic
11. Checks-Effects-Interactions pattern - state updated after external calls

## Zealynx 2026 (3 items)
12. Compute Unit overflow - unbounded loops or excessive CU usage
13. Token-2022 Transfer Hook risks - if applicable
14. Time-sensitive logic - timestamp or slot dependencies

## Cantina / QuillAudits (2 items)
15. Dependency vulnerabilities - check Cargo.toml versions against known CVEs
16. Access control completeness - all privileged operations protected. NOTE: Intentionally permissionless designs with no admin functions are acceptable and should be marked PASS if buy/sell operations are properly gated by signer constraints.

## Sealevel Attacks coral-xyz (10 items)
17. Signer Authorization
18. Account Data Matching
19. Owner Checks
20. Type Cosplay
21. Initialization - double-init protection
22. Arbitrary CPI
23. Bump Seed Canonicalization
24. PDA Sharing
25. Closing Accounts
26. Duplicate Mutable Accounts

For EACH item output EXACTLY this format:
| {number} | {name} | {source} | PASS / WARNING / FAIL | {one line reason} |

Then output a summary section:
## Summary
- Total checks: 26
- PASS: {n}
- WARNING: {n}
- FAIL: {n}
- Critical issues: {list or "None"}

Be precise and technical. Do not skip any item.
"""


def main():
    if len(sys.argv) < 2:
        lib_path = "programs/nautilus/src/lib.rs"
    else:
        lib_path = sys.argv[1]

    if not os.path.exists(lib_path):
        print(f"Error: {lib_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(lib_path, "r") as f:
        code = f.read()

    # Read Cargo.toml for dependency checks
    cargo_path = "programs/nautilus/Cargo.toml"
    cargo = ""
    if os.path.exists(cargo_path):
        with open(cargo_path, "r") as f:
            cargo = f.read()
        print(f"Cargo.toml found: {cargo_path}")
    else:
        print(f"Cargo.toml not found at {cargo_path}, skipping dependency check")

    print(f"Running security check on {lib_path}...")
    print(f"Code length: {len(code)} chars\n")

    result = call_claude(PROMPT, code, cargo)

    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a") as f:
            f.write("# Nautilus Security Check\n\n")
            f.write(f"**File:** `{lib_path}`\n\n")
            f.write("## Results\n\n")
            f.write("| # | Check | Source | Result | Notes |\n")
            f.write("|---|-------|--------|--------|-------|\n")
            # Extract only table rows and summary, skip preamble text
            lines = result.split("\n")
            filtered = [l for l in lines if l.startswith("|") or l.startswith("##") or l.startswith("-") or l.startswith("*")]
            f.write("\n".join(filtered))
            f.write("\n")
    else:
        print(result)

    if "| FAIL |" in result or "FAIL |" in result:
        print("\nSecurity check FAILED", file=sys.stderr)
        sys.exit(1)
    elif "WARNING" in result:
        print("\nSecurity check passed with warnings")
        sys.exit(0)
    else:
        print("\nSecurity check PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()