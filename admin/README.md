# Work-Time Monitor Admin PWA v0.8

Important fix:
- Daily counters now reset at **12:00 AM Dominican Republic time (America/Santo_Domingo / UTC-4)**.
- They no longer reset at midnight UTC (which is 8:00 PM in the Dominican Republic).

Counters:
- Connected Today = every detected status except OFFLINE.
- Interpreting Today = only INTERPRETING.

Date-range reports also interpret selected dates as Dominican Republic calendar days,
even when the admin dashboard is opened from a device in another timezone.

## Required database upgrade

Run:
`work-time-monitor-upgrade-v0.8-timezone-and-interpreting.sql`

This SQL is consolidated and is safe to run even if the prior v0.7 SQL was not executed.

## Update GitHub Pages

Replace the CONTENTS of the existing `/admin/` folder with the files in this PWA package.

Do NOT upload the SQL file to GitHub.

The admin URL stays the same:
`https://YOUR-GITHUB-USERNAME.github.io/work-time-monitor/admin/`

No employee-extension update is required.
