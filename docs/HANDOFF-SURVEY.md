# HANDOFF: workflow_survey — что меняется для скиллов плагина

Контракт для агента mneme-plugin. Движок получил read-only ориентировку: инструмент, который
отвечает «где я» по текущей ветке и **ничего не пишет**. До него `/mneme:resume` читал сырой
event-лог (`~/.mneme/<slug>/events/<YYYY-MM>.jsonl`) и вручную повторял restore движка — на
месячном файле в несколько мегабайт это перестало влезать в контекст. Скиллы здесь НЕ пишутся —
документ перечисляет, что плагинной стороне нужно отразить.

## Инструмент: имя и семантика <!-- HANDOFF-SURVEY-TOOL -->

- Внутреннее имя — `workflow_survey`; в реестре сессии он виден как
  `mcp__plugin_mneme_memory__workflow_survey` (тот же префикс, что у `workflow_start` /
  `workflow_step`; имя всё равно сверь с реестром после переподключения — правило из
  WORKFLOW-SKILL-CONTRACT).
- Ветку движок читает САМ (`git branch --show-current`), параметра `branch` нет — как у
  `workflow_start` и `workflow_step`.
- READ-ONLY ПО КОНСТРУКЦИИ: инструмент читает event-лог и git, но не пишет ни события, ни файла,
  ни stale-марки. Это проверено тестом идентичности корпуса (снимок дерева корпуса до/после
  вызова байт-в-байт равен). Следствие: вызов survey ничего не «дренирует» и ничего не
  «продвигает» — его можно звать сколько угодно раз.
- Что отвечает (plain text, как все инструменты движка):
  - незавершённый run текущей ветки: id, status, iterations, `started <ts>`,
    `last activity <ts>` (ts последнего события этого run'а), текущая фаза и pending-директива
    языком движка — `pending: execute_step <phase>/<step> attempt N` / `pending: harvest for
    phase <id>` / `pending: recall for phase <id>`;
  - `Staged notes awaiting review: N` — счётчик staging;
  - те же секции обзора, что видит `workflow_step`: ready-фазы, `Paused runs on other branches:`
    (live run'ы других существующих веток — так виден параллельный run в соседней копии
    проекта), `WARNING:` (ветка непроверяема), `LOG ANOMALIES:`;
  - `ORPHAN CANDIDATES (not yet marked):` — run'ы, чья ветка доказанно удалена. Survey их
    только ПОКАЗЫВАЕТ; марку `workflow_run_marked_stale` поставит следующий `workflow_start` /
    `workflow_step`. Не путать с `STALE RUNS` — той секции у survey не бывает никогда;
  - `Last terminal run on this branch: <id> [<status>].` и `Stale runs on this branch: K` —
    по одной строке, когда есть что показать.
- Без незавершённого run'а первая строка — `No unfinished workflow run on branch "<b>".`
- Detached HEAD → информационный текст «HEAD is detached: workflow runs are branch-scoped, so
  there is no branch to survey. No run state was read or changed.» — НЕ ошибка (`isError` не
  выставлен). Ошибка git → «git failed to resolve the current branch; no run state was read or
  changed.» Причина: ошибка инструмента логируется движком как `tool_error`, а survey обязан
  оставаться писателем ноля.

```
workflow_survey {}
```

## Флаг brief: одна строка <!-- HANDOFF-SURVEY-BRIEF -->

- Единственный параметр — `brief` (boolean, опционален). `brief: true` заменяет карту ОДНОЙ
  строкой без переводов строк.
- С активным run'ом:

```
<branch> · run <id> [<status>] · phase <phase-id> [pending: <directive>] · staged <N> · last <ts>
```

- Без активного run'а: `<branch> · no unfinished run · staged <N>`, плюс ` · <K> live elsewhere`,
  если на других ветках есть live run'ы.
- На detached HEAD `brief` отвечает тем же информационным текстом, что и карта.

```
workflow_survey { brief: true }
```

## Что меняется в /mneme:resume <!-- HANDOFF-SURVEY-RESUME -->

- `allowed-tools`: добавить `mcp__plugin_mneme_memory__workflow_survey`. `Read` и `Grep`
  event-лога из процедуры уходят: шаги «найти файл месяца», «отфильтровать по branch», «собрать
  closed/ready/blocked по step_applied» заменяются ОДНИМ вызовом `workflow_survey {}`. Никакого
  replay лога в скилле после правки — детерминированный restore живёт в движке.
- ORIENT-ONLY переформулируется: гарантия «ничего не меняю» реализуется как «пишет ничего», а не
  как «не трогает движок». Запрет на `workflow_start` / `workflow_step` / submit / `remember` /
  `recall` остаётся дословно; survey — единственный разрешённый инструмент движка.
- Карта фаз строится из ответа: закрытые/готовые фазы движок отдаёт в секции ready-фаз и в
  pending-директиве; для полной таблицы closed/blocked скилл по-прежнему может прочитать
  `phase-*.md` (deps) из `<corpus>/workflow/<slug>/` — это файлы фаз, не лог.
- Detached HEAD: скилл больше не читает `.git/HEAD` сам — он получает информационный ответ и
  останавливается, как и раньше.
- Подсказка продолжения (`/mneme:dev <slug> [until <id>]`) остаётся DATA, не меню — контракт
  FINALE-CLASS-INFORMATIONAL не меняется.

## SessionStart-хук: одна строка ориентировки <!-- HANDOFF-SURVEY-HOOK -->

- Хук `SessionStart` (рядом с `launch.sh --warm` в hooks.json) может печатать одну строку
  `workflow_survey { brief: true }` через `systemMessage` — агент с первого сообщения знает,
  на какой фазе стоит run и сколько заметок ждёт куратора.
- Три независимых аргумента за хук: агент не знает, где остановился; собеседник рассуждает по
  устаревшему снимку; resume тонет в логе. Survey закрывает все три одним read-only вызовом.
- Ограничения: вызов должен быть fail-open (нет движка / detached / ошибка git → строка не
  печатается, сессия не задерживается); запуск идёт через тот же бинарь движка, что и MCP-сервер,
  и не должен стартовать второй сервер параллельно с warm-прогревом.
- Частота ориентировок в лог НЕ пишется (событие `survey_requested` отклонено намеренно — оно
  сделало бы инструмент писателем); при нужде частоту считают по транскриптам.
