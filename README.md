# Work-Time Monitor Admin PWA v0.12.0

Attendance upgrade:
- Replaces the employee-facing Version card with Started Today.
- Adds Last Offline to show the latest explicit OFFLINE transition today.
- Adds Offline Today, which totals completed OFFLINE to AVAILABLE intervals after the employee starts the day.
- An open OFFLINE interval is added only after the employee returns to AVAILABLE.
- Both times use Supabase server timestamps and display in Dominican Republic time.
- Attendance remains optional/fault-tolerant so employees still load if the new RPC is not yet installed.

Live-monitoring upgrade:
- Supabase Realtime refreshes the employee snapshot as soon as a device or status event changes.
- A 15-second refresh remains as a fallback if the WebSocket is interrupted.
- Realtime reconnects automatically after temporary network interruptions.
- Employee list always loads from `monitor_admin_devices`.
- Interpreting and Calls are treated as secondary metrics.
- If either secondary RPC fails, employees remain visible and the affected metric falls back to 0.
- Date-range connected totals also remain visible if an optional metric fails.

Requires employee extension v0.5.8, the existing Realtime upgrade, and the v0.13 Offline Time SQL upgrade.
