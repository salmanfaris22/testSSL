# Connecting Metrix HR to the face-terminal attendance server

## Context

Three systems, one chain that is currently broken in the middle.

The two **ESSL AIFACE-MARS terminals** push every punch to **this server** (`server.js`, running at
`http://100.53.232.70:8080`) over the ZKTeco ADMS protocol. This server stores the raw taps and
derives a day model from them — repeat taps folded into movements, gate roles, hand-set In/Out marks,
and the labels Check in / Break start / Break end / Check out, with a day that ends on an arrival
left as *check-out pending*.

**Metrix HR** (`metrix360-hr-backend`) owns employees, shifts and leave, and its **Live Attendance**
screen reads from HR's own `AttendanceSession` + `AttendanceEvent` records. Nothing feeds those from
the terminals, so the screen stays empty no matter how many people tap.

This server already exposes a **read-only HR API** built for exactly this purpose — guarded by an IP
allow-list, with the URLs listed on the Server tab ready to hand to HR. The work is to point HR at
it, convert what comes back into HR attendance records, and give HR a Sync button.

---

## Architecture

```
   ┌──────────────────────┐
   │  ESSL AIFACE-MARS    │  gate ZHM2255300881  (check-in terminal)
   │  face terminals × 2  │  gate ZHM2255300866  (check-out terminal)
   └──────────┬───────────┘
              │  ADMS push (ZKTeco protocol, real time)
              ▼
   ┌─────────────────────────────────────────────┐
   │  THIS SERVER — 100.53.232.70:8080           │   system of record for punches
   │  ├── raw punch log      (attlog.jsonl)      │
   │  ├── day model          (fold, gate roles,  │
   │  │                       hand-marks)        │
   │  └── read-only HR API   (/api/hr/*)         │◄── IP allow-list guards this door
   └──────────┬──────────────────────────────────┘
              │  HTTP GET  — HR pulls: on a timer, and on the Sync button
              ▼
   ┌─────────────────────────────────────────────┐
   │  METRIX HR — metrix360-hr-backend           │
   │  ├── ingest service (PIN → employee)        │   ◄── to be built
   │  ├── AttendanceSession + AttendanceEvent    │
   │  └── Live Attendance screen                 │   lights up on its own
   └─────────────────────────────────────────────┘
```

HR **pulls**. This server never needs to reach out, and HR never needs an inbound port opened.

---

## The connection, concretely

### Step 1 — allow-list the HR server on this server's Server tab

> Read-only API for your HR system. Only the IP addresses listed here can call it — an empty list
> blocks everyone.

| Setting | Value |
|---|---|
| Allow-list entry needed | The **HR backend server's outbound (egress) IP** |
| Not this | `103.119.254.234` — that is the *browser* IP of whoever is looking at the settings page, not the HR server |
| Format | Comma separated. `*` = any |

**Two findings that will bite here:**

1. **The allow-list matches exact strings only.** `ipAllowed()` does
   `list.some(a => a === '*' || a === ip)` — there is **no CIDR / range support**. An entry like
   `49.37.0.0` matches only a caller whose IP is literally `49.37.0.0`; it does **not** cover
   `49.37.x.x`. Either give HR a fixed egress IP (AWS NAT Gateway / Elastic IP) or add prefix
   matching to `ipAllowed()`.
2. **An empty list blocks everyone**, including HR. That is the current state, so the API is closed
   until this step is done.

### Step 2 — the endpoints HR calls

Base: `http://100.53.232.70:8080`

| Endpoint | What HR gets | Use |
|---|---|---|
| `GET /api/hr/users` | Every enrolled person: `pin`, `name`, `card`, `privilege` (81 today, PINs 1–1039) | Build and maintain the PIN → employee mapping |
| `GET /api/hr/attendance?from=&to=` | Every employee's derived days: check-in, check-out, breaks, totals, **and the labelled movements** | The main feed |
| `GET /api/hr/attendance?pin=2&from=&to=` | One employee, same shape | Re-sync one person |
| `GET /api/hr/punches?from=&to=` | The raw taps behind the movements | Audit trail |

Ready to copy:

```
http://100.53.232.70:8080/api/hr/attendance?from=2026-09-01&to=2026-09-08
http://100.53.232.70:8080/api/hr/attendance?pin=2&from=2026-09-01&to=2026-09-08
http://100.53.232.70:8080/api/hr/punches?from=2026-09-01&to=2026-09-08
http://100.53.232.70:8080/api/hr/users
```

### Step 3 — what a day looks like coming back

The movement list HR receives for one person on one day is exactly what the dashboard shows:

| Step | Time | Gate | Taps |
|---|---|---|---|
| Check in | 10:05 AM | In · ZHM2255300881 | 1 tap |
| Break start | 3:33 PM | Out · ZHM2255300866 | 2 taps, first 3:30 PM |
| Break end | 4:07 PM | In · ZHM2255300881 | 1 tap |
| Check out | — | — | **Pending** — the day ends on an arrival, so nobody has left yet |

Each row maps to one HR `AttendanceEvent`. The times are already the **last** tap of each folded run,
so HR stores them as-is and re-derives nothing.

**A pending check-out needs no special handling.** HR's live status reads the *latest* event
(`adminAttendance.service.ts:988-1113`): `CHECK_OUT`→`checked_out`, `BREAK_START`→`on_break`,
`CHECK_IN`/`BREAK_END`→`checked_in`. So the day above shows as **Check in** on the Live Attendance
screen — correct, with zero mapping code.

---

## Field mapping

| This server | Metrix HR | Note |
|---|---|---|
| movement `label` | `AttendanceEvent.event_type` | `Check in`→`CHECK_IN`, `Break start`→`BREAK_START`, `Break end`→`BREAK_END`, `Check out`→`CHECK_OUT`. `Extra punch` is **not** sent |
| movement `time` | `timestamp` | Already the last tap of the run, in IST |
| `date` | `AttendanceSession.session_date` | Upsert on HR's existing unique `{user, session_date}` index |
| `pin` | `Employee.device_pin` → `Employee.user` | New field — see below |
| `key` (`sn\|pin\|time\|status`) | **new** `AttendanceEvent.device_key` | Idempotency key |
| `sn`, `taps`, `from` | `device_info` | "gate ZHM…881 · 2 taps, first 3:30 PM" survives into HR |
| raw punch rows | `DevicePunch` | Audit trail, via HR's existing device ingest |

### Identity: PIN → employee

The terminal knows a person only as a **PIN**. HR's only external key is `Employee.employee_code`
(6 chars, `A-Z2-9`, e.g. `LDE24J`) — unrelated to the PINs, and re-enrolling everyone with new PINs
would orphan the punches already recorded. So HR gains a field:

```
Employee.device_pin: { type: String, sparse: true, unique: true }   // beside employee_code
```

A punch whose PIN maps to no employee is **stored unmatched and listed**, never dropped and never
guessed. Assigning the employee later backfills it.

---

## Work to do

### On this server (`server.js`)

| # | Change | Why |
|---|---|---|
| 1 | CIDR / prefix support in `ipAllowed()` | So HR can be allow-listed as a range instead of one brittle address. Today `49.37.0.0` matches nothing |
| 2 | `X-API-Key` on `/api/hr/*`, allow-list kept as a second lock | The API is plain HTTP on a public IP. An IP allow-list alone is thin for employee attendance data — **put it behind HTTPS (reverse proxy) too** |
| 3 | `GET /api/hr/events` | The labelled movements as flat rows, so HR ingests instead of re-deriving |
| 4 | `?since=` cursor on `/api/hr/events` and `/api/hr/punches` | **The most important item.** See below |

**Why the cursor matters more than anything else here.** Every punch records both when it happened
(`time`) and when it reached this server (`recv`):

| Measured over all 3,983 punches | Number | Consequence |
|---|---|---|
| Arrived **>1h after they happened** | 3,706 (93%) | A sync asking for *"today's punches"* would never see them |
| Arrived within 2 min (true live) | 197 | The live path works, so a short interval is worth it |
| Largest single arrival batch | **2,164 rows in one minute** | The pull must page |
| `recv` out of order, or missing | **0** | `recv` is already a sound cursor — no new field needed |

Cost is not a concern: the whole company for a month computes in **111 ms**; one employee-month of
derived days is **20 KB**.

### On Metrix HR (`metrix360-hr-backend`)

| # | Change | Detail |
|---|---|---|
| 5 | Connection record + admin screen | Base URL, API key, interval, cursor, last status — mirroring `AttendanceConnection` in the team-lead backend |
| 6 | **Sync button** | Manual "sync now" and "re-sync this date range", exactly like the team-lead backend's `POST /tl-v2/attendance-sync/sync`. Reports `events_seen`, `events_saved`, `errors` |
| 7 | `AttendanceEvent.device_key` + **sparse unique index** | `AttendanceEvent.ts` has only a non-unique `{session, timestamp}` index today, so nothing prevents duplicates. Sparse means app/QR events are untouched. **Without this, every re-sync duplicates** |
| 8 | New `deviceAttendanceIngest.service.ts` | The conversion HR is missing: resolve `device_pin`→`Employee.user`; upsert `AttendanceSession` on `{user, session_date}` reusing the E11000 catch pattern at `attendance.service.ts:255-260`; upsert the event on `device_key`; then call the existing shared helpers `updateSessionTimestampsAndStatus()` + `recomputeAndPersistSessionBreakMetrics()` (`attendance.service.ts:141-168`) |
| 9 | `photo_url` placeholder | The model requires it and a terminal has no photo. **Reuse the existing convention** — the admin path writes `ADMIN_PHOTO_PLACEHOLDER` and `liveToday` nulls it on read; add a device equivalent. No schema change |
| 10 | Scheduled pull job | `src/jobs/deviceAttendanceSync.job.ts`, following `attendanceAutomation.job.ts`: `setInterval`, started from `server.ts:39-45` gated on `cluster.worker?.id === 1`. Calls the same ingest service as the Sync button |
| 11 | Unmatched-PIN screen | Lists punches whose PIN maps to no employee, one-click assign |

> Worth knowing: HR **already has** a device ingest (`POST /device/attendance`, `/iclock/cdata.aspx`)
> writing to a `DevicePunch` collection — but **nothing in the codebase ever reads it**. No job, no
> service, no report. That is why a terminal pushing there today never appears in Live Attendance.
> Item 8 is the conversion that was always missing.

### Phasing

| Phase | Delivers |
|---|---|
| **1** | Items 1–3, 5–9 — HR can pull a date range and press Sync; Live Attendance works |
| **2** | Items 4, 10 — the cursor and the timer; the link becomes hands-off and self-healing |
| **3** | Item 11 — the unmatched-PIN screen, once real data shows how often it happens |

---

## Verification

1. **Allow-list** — from the HR server, `curl http://100.53.232.70:8080/api/hr/users`. Expect
   `403 {"error":"forbidden","ip":"…"}` before the IP is added and a user list after. The `ip` in
   that error is the exact string to allow-list.
2. **The day above** — pull that person's day and confirm HR receives check in 10:05, break start
   3:33, break end 4:07, and no check-out.
3. **Live** — that person shows **Check in** (not Check out, not Absent) on the HR Live Attendance
   screen.
4. **Sync button idempotency** — press Sync twice over the same range; HR's event count must not
   change. Confirm the sparse unique index is what rejects the duplicate, not a silent code-level
   skip.
5. **App events unaffected** — a normal photo/GPS check-in still records while `device_key` is
   absent, proving the index is genuinely sparse.
6. **Backlog** — replay a 2,000-row dump into this server; confirm the pull pages through it and
   per-day totals land correctly.
7. **Unmatched** — punch with an unmapped PIN; confirm it is listed, not dropped, and that assigning
   the employee backfills it.
8. **Regression** — the local dashboard, the door button and `npm run check` all still pass; the
   team-lead backend's existing pull from HR is untouched.
