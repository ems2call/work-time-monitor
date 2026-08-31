# Work-Time Monitor Admin PWA v0.9.1

Hotfix:
- Employee list always loads from `monitor_admin_devices`.
- Interpreting and Calls are treated as secondary metrics.
- If either secondary RPC fails, employees remain visible and the affected metric falls back to 0.
- Date-range connected totals also remain visible if an optional metric fails.

No employee extension update is required.
No additional SQL is required beyond the existing v0.8/v0.8.1/v0.9 upgrades.
