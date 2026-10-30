# HANDOFF: дневник агента — что движок даёт плагину

Контракт для агента mneme-plugin. Движок получил сторону дневника: факты для ретро и одну строку
данных для хука. Плагин строит на них скилл `/mneme:diary` (ретро по прогону или по сессии) и хук
UserPromptSubmit, который на каждый промпт подмешивает агенту одну строку. Записи дневника — обычные
заметки через staging; движок по этому пути НИЧЕГО не пишет: ни события, ни файла, ни stale-метки.
Скиллы и хук здесь НЕ пишутся — документ перечисляет, что плагинной стороне нужно отразить.

Нужен движок со схемой событий v22: `remember` несёт `tags`, `session_start` несёт `pid`, событие
шага run'а несёт `gap` (recall фазы) и `staged_notes` (harvest). Run'ы до v22 честно отвечают
«not instrumented» там, где лог тогда этого не записывал.

## Тег записи дневника <!-- HANDOFF-DIARY-TAGS -->

- Запись дневника по run'у — обычная заметка через `remember` с двумя тегами: `diary` и `run:`
  с id run'а сразу после двоеточия (`run:01ARZ3NDEKTSV4RRFFQ69G5FA0`). Тип заметки движок не
  смотрит — четыре типа остаются прежними, выбор типа за скиллом. Якоря необязательны: заметка
  только с тегами валидна.
- «По run'у есть запись» ⇔ в логе есть `remember` (любой сессии) с обоими тегами, который
  поставил заметку в очередь (dedup не `noop`), и человек её не отклонил. Заметка, ждущая
  курации, — уже запись: хук перестаёт напоминать сразу после `remember`, не дожидаясь решения.
  Принятая и заменившая другую (supersede) — запись. Отклонённая — нет, напоминание вернётся.
- Ретро по сессии (без run'а) тегом `run:` не помечается; движок такую запись не ищет.

## Инструмент diary_facts <!-- HANDOFF-DIARY-TOOL -->

- `diary_facts` с необязательными аргументами `run_id` и `brief` — только чтение: лог событий и
  git (ветка), без событий, без создания корпуса, без stale-меток. Ни одна ветка ответа не бросает исключение: не-ответ — обычный
  текст без `isError`, иначе сервер записал бы `tool_error`.
- С `run_id` — факты ЗАВЕРШЁННОГО run'а любой ветки. Завершённый: статус complete / failed /
  escalated либо маркер abandoned или stale. Форма, строка за строкой (строки escalation и
  «before schema v22» — только когда есть что сказать; фазы — в порядке определения run'а):
  - `Diary facts for run <run_id> on branch "<branch>". Nothing was written: no event, no file, no stale mark.`
  - `status <status> · started <started_ts> · ended <ended_ts> · iterations <used>/<max>`
  - `diary entry: present` или `diary entry: none`
  - `escalation: <phase_id>/<step_id> — <reason>`
  - `curation: staged <staged> · accepted <accepted> · rejected <rejected> · superseded <superseded>`
  - `curation: <k> harvest(s) before schema v22 not counted`
  - `phase <phase_id>: not reached`
  - `phase <phase_id>: attempts <n> · bundle gap <gap> · harvest <kinds> · used notes <used>`
  - `  gate fail · attempt <n> · <kind> · <criterion> · <reason>`
  - `  remark: <text>`
- Значения строки фазы: попытки — наибольший номер попытки её шага; `bundle gap` — `yes` / `no` /
  `not instrumented`; `harvest` — виды заметок по алфавиту с числом (`bugfix 1, decision 2`), `none`
  (harvest ничего не поставил), `not run` (фаза до harvest не дошла) или для run'а до v22
  `<n> staged, kinds not instrumented`; `used notes` — число заявленных заметок бандла,
  `not instrumented` (декларации не было) или `not run`. Два частных вида строки:
  - `phase <phase_id>: attempts <n> · bundle gap not instrumented · harvest <staged> staged, kinds not instrumented · used notes not instrumented`
  - `phase <phase_id>: attempts <n> · bundle gap <gap> · harvest not run · used notes not run`
- Провал гейта: executable — причина движка (`exit-nonzero`, `timeout`, `spawn-error`,
  `malformed-command`); agent-judged — `fail votes <k>/<n>` и под ним remarks fail-голосов, по
  строке на remark. Курация считает только заметки, которые run поставил: последнее решение
  человека по каждой, без решения — `staged`. Цифр согласия с рекомендацией в ответе нет и не будет
  (NEUTRALITY): ретро не должно знать, как часто агент угадывал.
- Без `run_id` — ЭТА сессия сервера (он знает свой session_id): ручные recall'ы (не recall фаз),
  пробелы памяти по времени, заметки сессии, последний завершённый run текущей ветки:
  - `Diary facts for session <session_id>. Nothing was written: no event, no file, no stale mark.`
  - `recalls <recalls> · memory gaps <gaps> · notes <notes>`
  - `memory gaps: none` или заголовок `memory gaps, oldest first:` и строки пробелов:
  - `- <ts> "<query>"` — пробел, закрытый последующей заметкой;
  - `- <ts> "<query>" (open)` — пробел после последней заметки сессии (открытый);
  - `last terminal run on branch "<branch>": <run_id> [<status>] without a diary entry`
  - `last terminal run on branch "<branch>": <run_id> [<status>] has a diary entry`
  - `no terminal run on branch "<branch>"`
  - `HEAD is detached: no branch to look up a terminal run on.`
  - `git failed to resolve the current branch: no terminal run to look up.`
- Заметка сессии — `remember`, вызванный агентом и поставивший заметку (dedup `noop` не считается,
  harvest-заметки — не заметки сессии). Запись дневника — тоже заметка: она закрывает пробелы.
- `brief` равный true без `run_id` — одна строка (см. следующую секцию); когда сказать нечего —
  `diary: nothing to note`.
- Не-ответы, дословно:
  - `run_id is not a ULID or UUID. Nothing was written.`
  - `No workflow run <run_id> in this corpus. Nothing was written.`
  - `Run <run_id> cannot be read from the log: <problem>. Nothing was written.`
  - `Run <run_id> is still running on branch "<branch>": diary facts describe a finished run. Nothing was written.`
  - `brief describes the session only: pass brief or run_id, not both. Nothing was written.`

## Строка для хука <!-- HANDOFF-DIARY-BRIEF -->

- Одна строка: `diary: ` и непустые сегменты через ` · `. Сегментов два:
  - последний завершённый run текущей ветки, пока по нему нет записи дневника;
  - пробелы памяти, открытые с последней заметки сессии — не больше 5 последних по времени, в
    кавычках через запятую; если открытых больше, хвост называет число более ранних.
- Формы, дословно:
  - `diary: run <run_id> <status> without a diary entry · memory gaps since the last note: "<q1>", "<q2>"`
  - `diary: memory gaps since the last note: "<q1>", "<q2>", "<q3>", "<q4>", "<q5>" (+<k> earlier)`
  - `diary: run <run_id> <status> without a diary entry · memory gaps: n/a — <n> live sessions share this corpus`
  - `diary: nothing to note` — только у инструмента; CLI в этом случае молчит.
- Сегмент деградации печатает только CLI: он не знает сессию Claude и берёт единственную живую
  сессию сервера (правило — в секции CLI). Инструмент знает свою сессию и не деградирует.
- Query в строке: каждый управляющий символ (C0, DEL, C1) и разделители строк и абзацев Unicode
  становятся пробелом, серии пробелов схлопываются, края обрезаются; затем query длиннее 80 code
  points обрезается до 79 и получает `…`. Кавычки и обратные слэши внутри query НЕ экранируются —
  хук при сборке JSON экранирует ровно `\` и `"` (прецедент session-orient.sh): строка гарантированно
  однострочна, других символов, ломающих JSON-строку, в ней нет.

## CLI для хука UserPromptSubmit <!-- HANDOFF-DIARY-CLI -->

- Вызов — тот же бинарь движка, что `launch.sh` запускает как MCP-сервер, с подкомандой `diary` и
  флагом `--brief`:

```
mneme diary --brief
```

- Печатает brief-строку инструмента `diary_facts { brief: true }` байт-в-байт плюс перевод строки —
  для единственной ЖИВОЙ сессии сервера на этом корпусе. Нечего сказать — stdout пуст.
- Живая сессия: есть `session_start` с `pid`, нет `session_end` той же сессии, и процесс с этим
  pid существует (`kill(pid, 0)`: успех или EPERM — жив, ESRCH — нет). Сессия, убитая без
  `session_end` (закрытый терминал, SIGKILL), мертва по pid и не мешает. `session_start` движка
  до v22 pid не несёт и живой не считается. Ноль живых — сегмента пробелов нет (сегмент run'а
  остаётся); одна — её пробелы; две и больше — сегмент деградации с их числом. pid, доставшийся
  чужому процессу, даёт ложную «вторую» сессию — деградация, ошибка в безопасную сторону.
- Тихие исходы (stdout пуст, stderr пуст, exit 0): нечего сказать; корпуса проекта нет (корпус НЕ
  создаётся); битый `.mneme.json` или невалидный `MNEME_*`. Detached HEAD или ошибка git убирают
  только сегмент run'а — пробелы памяти печатаются.
- Непредвиденное исключение (например, корпус есть, а `events/` удалён): stdout пуст, ОДНА строка
  в stderr, exit 0.
- Exit-коды: 0 — всегда внутри грамматики `diary --brief`; 2 — кривой argv, с usage в stderr:
  - `usage: mneme diary --brief`
  - неизвестная подкоманда — `unknown invocation "<argv>"` и usage обеих подкоманд.
- Гарантия «пишет ничего» — как у `survey --brief`: на CLI-пути нет `EventWriter`, нет
  `resolveCorpus`, индекс не открывается; лог читается один раз.
- Движок без этой подкоманды (до v22) отвечает на `diary --brief` exit 2 с usage — хук обязан
  читать любой ненулевой exit как тишину.
- Бюджет timeout хука: замер — см. wire.

## Что строит плагин <!-- HANDOFF-DIARY-SKILLS -->

- Скилл `/mneme:diary`: грант `mcp__plugin_mneme_memory__diary_facts` и `remember`. Ретро по
  прогону — `diary_facts { run_id }`, запись — `remember` с тегами `diary` и `run:<run_id>` через
  staging (решение — цифрой куратора, как у любой заметки). Ретро по сессии — `diary_facts {}`;
  пробелы памяти из него — повод записать то, чего не хватило, обычными заметками.
- Хук UserPromptSubmit: гвард `[ -d "$HOME/.mneme" ] || exit 0` перед вызовом; бинарь через
  `launch.sh diary --brief`; ненулевой exit или пустой stdout — хук молчит; непустой — первая
  строка, экранирование `\` и `"`, `additionalContext` для агента. Хук срабатывает на КАЖДЫЙ
  промпт: timeout — по замеру выше.
- Строка — данные, не команда: скилл и правила плагина решают, когда агент предлагает ретро; хук
  ничего не запускает сам.
