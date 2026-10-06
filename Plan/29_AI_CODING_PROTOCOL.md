# 29_AI_CODING_PROTOCOL.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** AI-Assisted Development / Coding Protocol
**Version:** 1.0 Draft
**Status:** Cross-Cutting Process Specification — Final document in the core series
**Depends on:**
- `03_MASTER_PROJECT_SPECIFICATION.md` (§76–78, Development Philosophy/AI Coding Protocol/Code Change Rule)
- `04_PLATFORM_ARCHITECTURE.md` (§127–129, AI-Assisted Development/AI Coding Guardrails/Recommended Repository)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§126–130, Boundary Checklists — the concrete per-change checklists AI-generated code must satisfy)
- `13_SECURITY_SPECIFICATION.md` (§9.2, Code Review Checklist)
- `24_TESTING_STRATEGY.md` (§11, CI Gate Policy — the mechanical backstop this protocol relies on)
- `28_IMPLEMENTATION_ROADMAP.md` (§7, Definition of Done — this document operationalizes it for AI-generated changes specifically)

---

# 1. Purpose

এই document platform জুড়ে ছড়িয়ে থাকা AI-assisted/vibe-coding সংক্রান্ত সিদ্ধান্তগুলো (`03` §76–78, `04` §127–129, প্রতিটি module document-এ repeated "no unrelated refactor"-জাতীয় নীতি) একত্র করে একটি single, operational **protocol**-এ রূপান্তর করে — যা describe করে:

```text
Prompt construction discipline — কীভাবে AI-কে একটি change request
  দেওয়া হবে
Context package — কোন documents/files AI-কে প্রতিটি change-এর আগে
  দেওয়া বাধ্যতামূলক
Guardrails — AI কী করতে পারবে না (03 §77, 04 §128-এর concrete
  enforcement)
Review protocol — human review কী validate করবে, AI-generated
  diff-এর ক্ষেত্রে বিশেষভাবে কী দেখা হবে
Escalation — কখন AI-generated change একটি specification amendment
  দাবি করে (14-23-এ established "amendment flag" pattern-কে
  formalize করা)
Failure modes — এই protocol যা প্রতিরোধ করতে চায়, concretely
```

**Foundational rule carried forward (per `03` §76, restated as this document's central boundary):**

> AI-assisted/vibe coding ব্যবহার করা যাবে, কিন্তু AI specification override করতে পারবে না। Development সবসময় Documentation → Architecture → Specification → Implementation → Testing → Review → Release — এই sequence অনুসরণ করবে; কোনো ধাপ AI দিয়ে skip করা যাবে না, শুধু accelerate করা যাবে।

---

# 2. Why This Document Exists Separately

Every prior document already states version of this rule locally (e.g. `07` §20's Decision DOM-002, `19` §11's one-directional dependency arrow, `21` §8's "no new Core-facing hooks"). This document does **not** re-litigate any of those — it exists because:

```text
1. Those rules are scattered across 27 documents; an implementer
   (human or AI) working on a single PR should not need to have
   read all 27 to know the PROCESS by which a change is proposed,
   scoped, and reviewed.
2. "AI must not invent requirements" (03 §77) is a principle, not a
   procedure — this document supplies the procedure: what context
   an AI actually receives, in what shape, before it writes code.
3. The series' own internal pattern (Decision-per-document, amendment
   flags cascading from 14 onward) is itself evidence of a WORKING
   discipline — this document makes that discipline explicit and
   repeatable for the IMPLEMENTATION phase, not just the
   SPECIFICATION phase that produced 01-28.
```

---

# 3. Scope

```text
This protocol applies to:
  - Any code change (feature, fix, refactor) where an AI model
    generates some or all of the diff, regardless of which AI tool
    is used
  - Any specification AMENDMENT proposed as a byproduct of
    implementation (the "flagged amendment" pattern already used
    throughout 14-23)

This protocol does NOT apply to:
  - This documentation series itself (01-29) — authoring these
    documents follows the SAME Documentation → Review → Version
    discipline (03 §93-95), but that is an editorial process, not
    a coding one
  - Pure human-authored code with no AI generation involved — this
    protocol's guardrails (§6) are still good practice there, but
    the CONTEXT PACKAGE requirement (§5) is specifically an AI-
    assistance concern
```

---

# 4. The Development Sequence — Operationalized

Restates `03` §76 as a concrete per-change checklist:

```text
1. Requirement          -> which section of 01-28 already specifies
                            this? (If none — STOP, see §8, this is a
                            specification gap, not an implementation
                            task)
2. Design Decision       -> does the existing spec fully determine
                            the implementation shape, or does a
                            genuine engineering judgment call remain
                            (e.g. "exact IaC tool," per 25 §6.2 —
                            explicitly flagged as NOT requiring
                            spec amendment)?
3. Implementation        -> AI-assisted, per this document's §5-§7
4. Test                  -> per 24's matrices, the relevant ones for
                            the changed domain (24 §11.3's path-based
                            selection)
5. Review                -> per §7 below
6. Documentation update   -> ONLY if §2 revealed a genuine gap/
                            amendment — routine implementation
                            following an already-complete spec
                            requires NO documentation change
```

**Rule (restated as Decision PROT-001, §10):** step 1 is mandatory and non-skippable — no code change begins without first locating (or explicitly flagging the absence of) its governing specification section. This is the concrete mechanism preventing `03` §77's "Do not invent requirements" from being merely aspirational.

---

# 5. The Context Package — What AI Receives Before Writing Code

Concretizes `03` §77 and `04` §128 into an actual deliverable shape.

## 5.1 Minimum Required Context (per change)

```text
Every AI coding prompt for a non-trivial change includes:

  1. Goal              — one sentence, the user-facing or system
                          outcome, not an implementation description
  2. Governing Spec     — the SPECIFIC section(s) of 01-28 this
                          change implements (e.g. "07 §7.6 steps
                          4-11, InsufficientStockError path") — not
                          "the sales module" as a vague pointer
  3. Affected Module     — per 04 §84-85's folder structure, which
                          module(s) this change touches, and
                          EXPLICITLY which it must NOT touch
  4. Constraints          — any Architectural Non-Negotiable (03 §90)
                          this change must respect, named explicitly
                          if directly relevant (e.g. "idempotency via
                          operationId, per 07 §17" for any mutation)
  5. Acceptance Criteria   — the specific test matrix rows (24 §3-§8)
                          this change must satisfy, or the specific
                          NEW test cases required if this is genuinely
                          new behavior
  6. Files Allowed to
     Change                — an explicit allowlist, not "figure out
                          what's relevant" — mirrors 04 §128's
                          "Files allowed to change" requirement
                          verbatim
```

## 5.2 Why "Files Allowed to Change" Is Explicit, Not Inferred

```text
An AI model given a loosely-scoped prompt ("fix the return quantity
bug") will often "helpfully" touch adjacent files it judges related
— renaming a variable in a neighboring service, reformatting an
unrelated function, adjusting a type it notices looks inconsistent
elsewhere. Per 04 §128 ("Unrelated refactor করবে না"), this is
explicitly forbidden, and the concrete enforcement mechanism is: the
prompt names the allowed file set UP FRONT, and any diff touching a
file outside that set is treated as a protocol violation at review
time (§7.2), regardless of whether the out-of-scope change is
"technically correct."
```

## 5.3 Repository AI-Readable Documentation (per `04` §127)

```text
The repository itself carries a persistent, lower-level companion to
this document:

  AGENTS.md / AI_RULES.md    — repository root, points back to this
                                document (29) as the authoritative
                                process, plus repo-specific mechanics
                                (how to run tests locally, lint
                                commands, etc.) that don't belong in
                                an architecture specification
  Per-module README            — per 04 §127's "প্রতিটি module-এর
                                README/Business Rules/API/Data Model/
                                Tests," a SHORT index pointing to the
                                relevant sections of 06-23 that govern
                                that module — not a duplicate of this
                                series' content, a pointer into it

This keeps the SOURCE OF TRUTH in 01-29 (versioned, reviewed,
authoritative per 03 §93-95) while giving an AI tool operating
directly in the repository a fast, low-token-cost way to find the
relevant sections without re-reading all 29 documents on every
prompt.
```

---

# 6. Guardrails — What AI Must Never Do

Restates `03` §77 and `04` §128 as an exhaustive, checkable list — this is the direct implementation-phase counterpart to `22` §9's "what AI must never do" applied there to the PRODUCT's own AI features; here it applies to the AI TOOLS used to BUILD the product.

## 6.1 The List

```text
[ ] Do not invent requirements — if the prompt or context package
    doesn't specify a behavior, the AI proposes a question back to
    the human, it does not guess and proceed (mirrors 22 §5.3's
    "grounding failure" pattern, applied here to coding tasks
    instead of business-data queries)
[ ] Do not change unrelated modules — per §5.2's explicit file
    allowlist
[ ] Do not silently change schema — any migration file the AI
    generates is flagged prominently in its own output/PR
    description, never buried inside an unrelated feature diff
    (mirrors 04 §65's "No manual production schema edit" principle,
    extended to "no SILENT schema edit even via an authorized
    migration tool")
[ ] Do not bypass domain rules — an AI asked to "make this test
    pass" must not weaken/remove the INVARIANT the test checks (e.g.
    loosening ReturnEligibilityPolicy's boundary per 07 §12.2) as a
    shortcut; this is the single most dangerous class of AI-
    assisted regression and is called out explicitly (§6.2)
[ ] Do not duplicate business logic — before implementing a
    calculation/validation, the AI's context package (§5.1 item 2)
    should already point to the EXISTING service/policy that owns
    it (e.g. SalePricingService, per 14 §5.1's reuse pattern) —
    writing a second parallel implementation is a protocol violation
    even if the new code is independently correct
[ ] Do not bypass security — no AI-generated change disables/weakens
    a guard chain step (11 §20, 13 §3) to make a feature "work" more
    easily; if a legitimate use case seems blocked by the guard
    chain, that is escalated (§8), not routed around
[ ] Do not fabricate test coverage — an AI-generated test that always
    passes regardless of the implementation (a "tautological" test)
    is treated as equivalent to NO test at Review (§7), not credited
    toward Definition of Done (28 §7)
```

## 6.2 Special Emphasis — Never Weaken a Test to Make It Pass

```text
This is flagged separately from §6.1's list because it is the
failure mode most specific to AI-assisted development (a human
implementer weakening a business rule to pass a test is a
CONSCIOUS act a code reviewer would likely challenge directly; an
AI model, optimizing purely for "make the red test green," has no
inherent signal that WEAKENING the assertion is qualitatively
different from FIXING the implementation — both make the test pass).

Concrete rule: if an AI-proposed diff changes both (a) implementation
code AND (b) the assertion/expected-value in an EXISTING test within
the same change, that diff requires EXPLICIT human justification in
the PR description for why the test's prior assertion was wrong
(not merely inconvenient) — this is a mandatory Review gate item
(§7.2), not a soft guideline.
```

---

# 7. Review Protocol

## 7.1 What Human Review Validates (AI-generated diffs specifically)

```text
In addition to ordinary code review concerns (correctness, style,
performance), a reviewer examining an AI-assisted diff explicitly
checks:

[ ] Does the diff stay within §5.1 item 6's allowed file set?
[ ] Does the diff cite its Governing Spec section (§5.1 item 2) in
    the PR description, and does the actual code match what that
    section specifies — not just plausibly related to it?
[ ] Does the diff introduce a schema change? If so, is it flagged
    prominently (§6.1), and does it follow the "additive first"
    rule (04 §168)?
[ ] Does the diff touch an existing test's assertions? If so, is the
    §6.2 justification present and does it hold up to scrutiny?
[ ] Does the diff duplicate logic that already exists elsewhere
    (§6.1's "no parallel implementation" check)?
[ ] Does the diff satisfy the relevant CI Gate matrices (24 §11) —
    checked mechanically by CI, but the reviewer confirms the RIGHT
    matrices were even triggered for this change's file paths
    (24 §11.3)
```

## 7.2 Protocol Violation Handling

```text
A diff that violates §5.2's file-scope rule or §6's guardrails is
NOT "fixed in review" by silently trimming the out-of-scope parts —
it is returned to be RE-GENERATED against a corrected/expanded
context package (§5), so the same violation class doesn't recur on
the next prompt in the same session. This mirrors the platform's own
"reversal over destructive edit" principle (02 §52) applied to the
DEVELOPMENT PROCESS itself: correct the input (the prompt/context),
don't patch around a wrong output.
```

## 7.3 CI as the Mechanical Backstop

```text
This entire protocol is a discipline for producing GOOD prompts and
GOOD review — it is not the platform's only defense. Per 24 §11's CI
Gate Policy, even a diff that passes human review incorrectly still
cannot merge if it fails the Tenant Isolation matrix, Financial
matrix, or any other applicable blocking gate. This protocol reduces
how OFTEN a bad diff reaches review; it does not replace CI as the
final, mechanical, non-negotiable check (05 §163's "no override
path" applies regardless of how the diff was authored).
```

---

# 8. Escalation — When a Change Requires a Specification Amendment

Formalizes the pattern already used throughout `14`–`23` (e.g. Decision QTN-001's `06` §6.1 amendment, Decision SRV-003's narrow `07` §7.6 extension) as an explicit, repeatable procedure for ALL future implementation work, not just the documents that already used it.

## 8.1 Trigger Conditions

```text
Escalate (do not silently implement a workaround) when:

  1. §4 step 1 finds NO governing spec section for a required
     behavior — a genuine gap, not an oversight in reading
  2. The existing spec's rule, if followed literally, appears to
     conflict with another spec's rule (e.g. two documents implying
     contradictory validation order) — Change Management applies
     (03 §94), this is never silently resolved by picking one
     arbitrarily
  3. Implementation reveals that an existing Use Case needs a
     narrow, backward-compatible extension point to support a new
     module/feature (the exact pattern of 15 §6, 17 §5.3, 19 §6,
     20 §5.2) — this is EXPECTED and welcomed, but must be
     explicitly flagged and documented, never added as an
     undocumented side-effect
  4. A "Open Question" already flagged in the relevant document
     (per every document's own final section) has now become
     blocking for the change at hand — 28 §8's Risk Register
     triage applies: if this was already a Phase-blocking item,
     it should have been resolved before reaching this point; if
     it was a §8.4-class deferred item, its escalation here is the
     signal that its deferred status should be reconsidered
```

## 8.2 Escalation Procedure

```text
1. Change Request        — describe the gap/conflict/needed
                            extension point plainly (per 03 §94)
2. Impact Analysis         — which existing document(s) does this
                            touch? (mirrors the "Amendment flag"
                            pattern's own citation style, e.g.
                            "amendment to 06_DATABASE_SPECIFICATION.md
                            §6.1")
3. Affected Documents        — enumerate them explicitly
4. Decision                   — resolved by whoever holds
                            specification authority for this project
                            (Nazmul, per this project's own
                            established working pattern) — an AI
                            tool proposes the analysis (1-3), it does
                            not unilaterally decide (4)
5. Version Update              — the SOURCE document (not just this
                            protocol document) is updated, per 03
                            §95's Major.Minor versioning
6. Implementation                — proceeds only after step 5, using
                            the now-updated spec as §4 step 1's
                            Governing Spec citation
```

**Rule (restated as Decision PROT-002, §10):** an AI tool may DRAFT an amendment proposal (steps 1–3) but never AUTOSAVE/apply one (step 5) — this is the direct implementation-phase enforcement of `03` §94's "AI-generated change নিজে থেকে specification change করবে না।"

---

# 9. Failure Modes This Protocol Prevents — Concrete Examples

Restated as illustrative (not exhaustive) scenarios, grounded in this series' own established invariants, to make the abstract guardrails (§6) tangible:

```text
Scenario A — "Just make the discount test pass"
  An AI asked to fix a failing discount-limit test, without the
  Governing Spec context (07 §21 Q2's discount threshold, once
  resolved per 28 §8.2), might raise the hardcoded limit rather than
  implement the actual permission-based check. §6.2's rule catches
  this: raising a limit IS a test-assertion change, requiring
  explicit justification a reviewer can immediately see is missing.

Scenario B — "Add a quick industry check"
  An AI implementing a Decorator-specific behavior, without being
  pointed to 21 §8's extension-point pattern, might add
  `if (tenant.industry === 'decorator')` directly inside Core's
  sales/domain code — the exact anti-pattern 01 §55 and 04 §133
  forbid. §5.1 item 2's Governing Spec citation (pointing to 21 §5.3's
  actual documented parameter-addition pattern) prevents this by
  giving the AI the CORRECT existing pattern to follow instead of
  inventing a shortcut.

Scenario C — "Optimize this slow query"
  An AI asked to speed up a report query might restructure
  core.stock_balances to be independently writable for performance,
  violating Decision DB-001 (06 §13) that it must remain a derived
  cache. §5.1 item 4's explicit Constraints field (naming this
  Non-Negotiable directly when relevant) prevents this by making the
  invariant visible in the PROMPT, not just discoverable by reading
  06 in full.

Scenario D — "This tenant check seems redundant, I'll simplify it"
  An AI performing an unrelated refactor near a tenant-scoping check
  might "clean up" what looks like defense-in-depth redundancy
  (e.g. removing an application-layer tenant filter because RLS
  already covers it, per 05 §26's explicit "RLS-এর পাশাপাশি
  Application Authorization... থাকবে" layering). §5.2's file
  allowlist prevents this from happening as a DRIVE-BY change in an
  unrelated PR; if genuinely proposed, it must go through §8's
  escalation as a deliberate architecture question, not a silent
  simplification.
```

---

# 10. Decisions Established by This Document

### Decision PROT-001
No AI-assisted code change begins without first locating its governing specification section (`§4` step 1) — an unlocatable requirement is treated as a specification gap requiring escalation (`§8`), never as license to improvise.

### Decision PROT-002
An AI tool may draft a specification-amendment proposal (impact analysis, affected-documents list) but may never itself apply that amendment to a source document — amendment decisions remain a human specification-authority action, consistent with `03` §94's original rule, now given a concrete implementation-phase procedure.

### Decision PROT-003
Every AI coding prompt for a non-trivial change carries an explicit, bounded "Files Allowed to Change" list (`§5.1` item 6) — a diff touching files outside that list is a protocol violation regardless of whether the additional change is independently correct, and is returned for re-generation (`§7.2`) rather than trimmed in review.

### Decision PROT-004
Any AI-generated diff that modifies both implementation code and an existing test's assertions within the same change requires explicit written justification in the PR description (`§6.2`) — this is a mandatory review-gate item, not a style suggestion, because weakening a test to make it pass is the failure mode most specific to AI-assisted development.

### Decision PROT-005
This protocol (`29`) is a discipline that reduces how often a flawed AI-generated change reaches review; it does not replace the mechanical CI Gate Policy (`24` §11) as the platform's final, non-negotiable correctness backstop (`§7.3`).

---

# 11. Open Protocol Questions

```text
1. Should the "Governing Spec citation" (§5.1 item 2) be a MACHINE-
   CHECKABLE field (e.g. a required PR template field cross-
   validated against actual document section anchors), or does a
   human-readable convention suffice at current team scale?
2. As this series itself continues to grow (new module/industry
   documents beyond 21, new cross-cutting documents beyond 29), does
   the AGENTS.md/per-module-README indexing layer (§5.3) need its
   own maintenance protocol, or is it regenerated/reviewed as a
   byproduct of each new document's own authoring?
3. Should repeated protocol violations by a given AI tool/model
   configuration (§7.2) trigger a review of whether that tool's
   context-window/prompting setup itself needs adjustment, distinct
   from any single PR's outcome — i.e., should this document track
   tool-level failure patterns over time, or remain purely per-change?
4. §8.1's escalation triggers assume a single specification authority
   (Nazmul, per this project's established pattern) — does this
   process need a defined fallback/delegation path for periods when
   that authority is unavailable, given active implementation cannot
   indefinitely block on a single decision-maker?
5. Given `28` §10 Q4 already asked whether this document was needed
   at all — now that it exists, should its content be partially
   folded back into `03`/`04` (its primary sources) to avoid a
   "protocol vs principle" split across two layers, or does keeping
   process (this document) separate from architecture (`03`/`04`)
   remain the right layering?
```

---

# 12. Documentation Series — Final Closing Note

এই document দিয়ে `03_MASTER_PROJECT_SPECIFICATION.md` §92-এ মূলত পরিকল্পিত সম্পূর্ণ Documentation Hierarchy (`01`–`29`) সম্পূর্ণ হলো।

```text
01-03   Foundational (Audit, Domain, Master Spec)
04-06   Architecture (Platform, Multi-Tenant, Database)
07-09   Domain Engines (Core, Accounting, Inventory)
10-13   Cross-Cutting Core Systems (Offline/Sync, API, UX, Security)
14-18   Optional Modules (Quotation, Service, Rental, Project, Booking)
19-21   Industry Extensions (Pharmacy, Electronics, Decorator)
22-23   Intelligence & Automation Layers (AI, Automation)
24-27   Delivery Systems (Testing, Deployment, Billing, Migration)
28      Implementation Roadmap (Synthesis)
29      AI Coding Protocol (this document — Process)
```

**A final observation, made possible only now that the series is complete:** this project's own construction — 29 documents, each explicitly citing and building on its predecessors, each ending with a `Decisions Established` section and an `Open Questions` section that later documents either resolve or knowingly defer — is itself a working demonstration of the exact discipline `03` §76 and this document (`29`) prescribe for the CODE that will now be built from it. The specification series did not merely describe traceability, reversal-over-destructive-edit, explicit dependency direction, and amendment-over-silent-change; it was produced under those same rules throughout. Implementation is expected to hold itself to no lower a standard.

**Status: Documentation Series (01–29) — COMPLETE, pending specification-authority sign-off and Phase 1 kickoff per `28`.**
