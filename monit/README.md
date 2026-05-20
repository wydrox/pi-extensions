# monit extension

Globalne komendy:

- `/monit <polecenie naturalne>` — przygotowuje `.pi/monit/`, tworzy/reuse sesję tmux i wysyła do agenta workflow auto-fixów z użyciem tmux.
- `/monitb <polecenie naturalne>` — jak wyżej, ale tylko triage/backlog, bez zmian w kodzie.
- `/monit-status` — pokazuje ostatnią sesję, log i backlog dla bieżącego projektu.

Pliki projektu tworzone przez extension:

- `.pi/monit/runtime.log`
- `.pi/monit/BACKLOG.md`
- `.pi/monit/RUNBOOK.md`
- `.pi/monit/current.json`

Po dodaniu extension uruchom w pi `/reload` albo zrestartuj sesję.
