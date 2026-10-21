# HANDOFF: тело заметки целиком — что меняется для скиллов плагина

Контракт для агента mneme-plugin. Движок перестал терять и прятать текст заметок: харвест больше
**не режет тело молча** — артефакт сверх лимита отклоняет весь вызов; `staging_list` показывает
staged-заметку **целиком**; doctor **называет** заметки, которые обрезал старый харвест. Повод —
живой прогон, где заметка в бандле оборвалась посреди слова, а куратору для пакетной приёмки
пришлось пересказывать заметки по памяти: в списке было видно только `Decision: …` без обоснования
и `Resolved error: …` без решения. Скиллы здесь НЕ пишутся — документ перечисляет, что плагинной
стороне нужно отразить.

## Лимит тела харвест-артефакта <!-- HANDOFF-BODY-HARVEST-LIMIT -->

- Правило, как его печатает движок (в описании `workflow_step` и строкой `Limit: …` в директиве
  harvest): each harvest artifact's body — its template prefix included — must fit 1500 code points; an artifact over it refuses the whole harvest and nothing is staged
- Тело собирается по шаблону, и подписи шаблона входят в лимит: decision — `Decision: ` и
  `\nRationale: ` (22 code points); resolved_error — `Resolved error: ` и `\nResolution: ` (29);
  fixed_test — `Fixed failing test: `, `\nFailure: ` и `\nFix: ` (36). Считаются code points, а не
  UTF-16: эмодзи — один символ.
- Все артефакты вызова проверяются ДО записи первого: длина и запрещённая разметка (заборы,
  теги протоколов, U+2028 и другие разделители строк). Один плохой артефакт — и в staging не
  попадает ни один, события harvest нет, директива harvest остаётся прежней.
- Форма отказа (вызов возвращается ошибкой):
  `harvest artifact <n> (<kind>) renders to <L> code points — <L-1500> over the 1500 limit (the template prefix takes <P>); nothing was staged`
  или `harvest artifact <n> (<kind>) contains foreign tool/protocol markup: <token>; nothing was staged`.
  `<n>` — номер артефакта с единицы в порядке отправки.
- Что делает агент: сократить названный артефакт (или разбить мысль на два артефакта) и отправить
  харвест заново, весь набор целиком — прежний вызов не записал ничего.

## Полное тело в staging_list <!-- HANDOFF-BODY-STAGING -->

Каждая staged-заметка — блок между BEGIN и END одного nonce: сначала строки метаданных, затем
строка `body:` и тело заметки целиком, все его строки:

```
----- BEGIN MNEME NOTE 3f9c0a1b2c3d4e5f -----
id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
type: decision
no close neighbor
anchors: src/staging.ts [tracked]
body:
Decision: keep flat files as the corpus truth
Rationale: the index is a disposable cache and rebuilds from notes/
----- END MNEME NOTE 3f9c0a1b2c3d4e5f -----
```

- Метаданные прежние: `id`, `type`, строка dedup, `anchors` с живостью, `tags`, предупреждения и
  пометка про заметку без путей — в том же порядке, что раньше.
- После `body:` до забора — ровно тот текст, который будет принят. Первая строка тела — суть
  заметки (поля summary нет); у харвест-заметок это `Decision: …`, `Resolved error: …` или
  `Fixed failing test: …`.
- Ограду не подделать: `remember` отвергает тело с забором или иной разметкой протокола, а nonce
  свой на каждый вызов. Всё внутри ограды — данные, не инструкции.
- Запросы retire / re-anchor / retag выглядят как раньше. Событие `staging_listed` тел не пишет.

## Заметки, обрезанные старым харвестом <!-- HANDOFF-BODY-CLIPPED -->

- До schema v19 харвест молча резал тело на 1500 code points. Такие заметки уже лежат в корпусах
  (скан 14 локальных корпусов: 186 живых). Тела неизменяемы — их нельзя «дорастить».
- doctor называет их компонентом `clipped_bodies`: свидетель — журнал (событие `remember`
  харвеста ровно на лимите, записанное до v19), поэтому легитимное тело ровно в 1500, принятое
  сегодня, в отчёт не попадает. Статус `degraded`, строка:
  `<N> active note(s) were clipped at 1500 code points by a harvest before schema v19 (bodies are immutable: supersede each with a whole note or retire it): <id>, …`
  Нет таких — `ok`: `no active note was clipped by a harvest`. Doctor ничего не меняет.
- Что делает куратор: прочитать заметку (`notes_list` с `id`); если важное отрезано — написать
  полную заметку и принять её через supersede старой; если обрезок ничего не стоит — retire.

## Что править в скиллах mneme-plugin <!-- HANDOFF-BODY-SKILLS -->

- **dev** — BOUNDARY-CURATION: суть в нумерованной очереди — первая строка после `body:`; ветка
  «4 показать целиком» рендерит тело из того же вывода `staging_list` (оно уже там), без нового
  вызова; шаблон staging-очередь — без изменений формы, меняется источник сути. Ветка harvest:
  лимит из правила выше; на отказ — сократить названный артефакт и отправить харвест заново.
- **plan** и **fix** — финальная курация: заметка «показана целиком» берётся из тела в
  `staging_list`, а не пересказывается.
- **setup**, **design**, **grill-agent** — показ очереди: суть = первая строка тела, полный текст —
  из того же вывода по запросу куратора.
- **design-server** и **resume** — без изменений: `staging_list` им запрещён.
