# 1099 e-filing: IRIS TCC application plan

**Written 2026-08-19.** Sources are IRS pages current as of that date (linked at the
bottom). Verify anything time-sensitive against irs.gov before you file — this is a
regulatory process and the IRS moves dates.

## Why this is urgent (the timing math)

| Fact | Date |
|---|---|
| Today | 2026-08-19 |
| TCC application processing | **up to 45 days** |
| Last day to change an IR Application for TCC | **2026-11-09** |
| FIRE shuts down for good | **after 2027-01-01** — IRIS becomes the only system |

Applying today lands your TCC in early October with a comfortable buffer. Applying in
October risks missing the November 9 window, and there is no FIRE fallback for the
2027 filing season. **This is the single most schedule-critical item on the roadmap.**

## You are required to e-file

Since tax year 2023 the threshold is **10 or more information returns** across all
types combined. With ~250 clients, most of them contractor-heavy, you are far past
it. Paper filing 1099s is not a legal option for your practice — this isn't an
efficiency upgrade, it's compliance.

## Which application to file: **Transmitter**

The IRIS TCC application offers three roles:

- **Issuer** — "your business only." Wrong for you: it only covers KP's own 1099s.
- **Transmitter** — "your business and others." ✅ **This is yours.** It covers
  filing information returns on behalf of your clients.
- **Software developer** — for vendors writing filing software for resale. Not you.

Choosing Issuer by mistake is the most common wrong turn here, and it would leave you
unable to file for a single client.

## What to gather before you start

1. **Your firm's EIN.** Required; a TCC cannot be issued against an SSN.
2. **An ID.me account for every authorized user you list.** Each person listed must
   have their own — you cannot share one login. Have your two helpers create theirs
   before you start the application if you intend to list them.
3. **Responsible Officials.** People with authority over the firm's information-return
   filing. Expect to supply name, title, SSN, date of birth, email, and phone for each.
   List at least two so a single vacation doesn't freeze your filing ability.
4. **Contacts.** Day-to-day people the IRS can call about a transmission.
5. **Your firm's legal name and address exactly as the IRS has them** for the EIN.
   Mismatches here are a common rejection cause.

## Steps

1. Sign in at **https://www.irs.gov/tax-professionals/iris-application-for-tcc** with
   ID.me.
2. Start an **IRIS Application for TCC**, selecting the **Transmitter** role.
3. Add Responsible Officials and Contacts; each authorized user completes their own
   identity verification.
4. Each Responsible Official signs the application with their PIN.
5. Submit, then watch for the TCC. Budget 45 days.
6. **Record the TCC somewhere durable** — put it in Secret Manager alongside the other
   KPBooks secrets, not in a text file on one laptop.

## Open question to resolve from Publication 5903

The IRS page did not state whether the **portal** (manual/CSV upload) and **A2A**
(machine-to-machine API) transmission methods require the same TCC or separate ones.
Publication 5903 (the IRIS Application for TCC tutorial) is the authority. Resolve
this during the application — if they are separate, request both, because:

- **Portal** is the fastest path to filing for a handful of clients, and a fine
  fallback if the API integration has a bad day in January.
- **A2A** is what makes 250 clients tractable without human copy-paste, and is what
  KPBooks should ultimately drive.

Requesting both costs nothing extra and avoids a second 45-day wait in December.

## What gets built in KPBooks once the TCC arrives

KPBooks already generates 1099-NEC and 1099-MISC PDFs and has the 1099 prep pre-flight
(vendor totals, missing-W-9 detection, TIN checks). The remaining work:

1. **IRIS submission format** — build the transmission payload from existing 1099 prep
   data. Per-client issuer records nested under KP as transmitter.
2. **Submit + poll status** — IRIS is asynchronous: you submit, then poll for
   acceptance or per-record errors.
3. **Error triage UI** — a rejected record (bad TIN, name/TIN mismatch) has to be
   fixable and resubmittable without redoing the batch. This is where a filing season
   is won or lost.
4. **Corrections** — filing a corrected 1099 after the original was accepted.
5. **Audit trail** — what was filed, when, for whom, with what confirmation. Your
   existing activity log is the natural home.

Best time to build: **October–November**, once the TCC is in hand and the IRIS schema
for the processing year is published, so we build against the real spec rather than
last year's.

## Sources

- [IRIS application for TCC](https://www.irs.gov/tax-professionals/iris-application-for-tcc)
- [E-file information returns with IRIS](https://www.irs.gov/filing/e-file-information-returns-with-iris)
- [Publication 5718 — IRIS processing year 2026](https://www.irs.gov/pub/irs-pdf/p5718.pdf)
- [Publication 1220 (Rev. 5-2026)](https://www.irs.gov/pub/irs-pdf/p1220.pdf)
- [Topic no. 802 — applying to file information returns electronically](https://www.irs.gov/taxtopics/tc802)
