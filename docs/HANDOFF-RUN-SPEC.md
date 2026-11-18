# HANDOFF: прогон знает свою спеку — что меняется для скиллов плагина

Контракт для агента mneme-plugin. Движок теперь сам связывает прогон со спекой: стартует прогон по
slug мигрированной спеки, читая её фазы и Knowledge из своего корпуса, записывает в событие старта
slug и HEAD проекта, а read-only `workflow_spec` отдаёт спеку прогона, мигрированную спеку или список
мигрированных спек. Плагину больше не нужно знать, где лежит корпус и как он назван (munged-имя,
`corpus.name` из `.mneme.json` или `MNEME_CORPUS_NAME`). Скиллы здесь НЕ пишутся — документ
перечисляет, что плагинной стороне нужно отразить, отдельной задачей.

## Что изменилось в движке

- `workflow_start` принимает РОВНО ОДИН источник фаз:
  - `spec_slug` — slug спеки, которую `workflow_migrate` уже записал в корпус проекта; движок сам
    читает все её `phase-*.md` и Knowledge её архива `specs/<slug>.md`;
  - `phases` — тексты фазовых документов, как раньше; такой прогон записывает, что спеки у него нет.
  Оба сразу или ни одного — отказ до любого чтения: `pass phases or spec_slug, not both` и
  `pass phases or spec_slug: neither was given`. Неизвестный slug, фазовый файл, который не
  разбирается, или Knowledge архива, которая не разбирается, — отказ старта, событие не пишется.
  Если на ветке уже есть незавершённый прогон, возвращается его id, а `spec_slug` не читается вовсе.
- Событие `workflow_run_started` (схема событий v25) несёт `spec` — `{slug, knowledge}` или `null`
  для старта текстами — и `base_commit` — HEAD проекта на старте или `null` в репозитории без
  коммитов. Старт до v25 не несёт ни того, ни другого и читается как «не записано».
- `workflow_spec` — новый read-only инструмент: ничего не пишет (ни события, ни файла), любой
  не-ответ — текст, а не ошибка. Три формы вызова: `{ run_id }` — спека прогона любой ветки, и
  завершённого, и идущего; `{ spec_slug }` — мигрированная спека, как она в корпусе сейчас; `{}` —
  список мигрированных спек.
- `diary_facts { run_id }` печатает строку спеки сразу после строки `status …`.

## Форма строк <!-- HANDOFF-RUN-SPEC-SHAPE -->

Строка спеки — одна и та же в `diary_facts { run_id }` и второй строкой ответа
`workflow_spec { run_id }`. Три состояния каждого сегмента: спека по slug или HEAD; старт текстами
или репозиторий без коммитов; старт до схемы v25:

```
spec sample-spec · base commit 0123456789abcdef0123456789abcdef01234567
spec none · base commit none
spec not recorded · base commit not recorded
```

Ответ `workflow_spec { run_id }` прогона, начатого по slug: заголовок, строка спеки, блок Knowledge
и все фазы — каждая после своих зависимостей, при равенстве по id — со всеми критериями done-when в
том виде, в каком их проверяли гейты прогона:

```
Spec of run 01ARZ3NDEKTSV4RRFFQ69G5FA0 on branch "main". Nothing was written: no event, no file, no stale mark.
spec sample-spec · base commit 0123456789abcdef0123456789abcdef01234567
knowledge:
- **Rule.** read the archive across two lines.
- **Limit.** the base commit separates commits only.
phase parse-input · deps none
- executable: bun test src/parse.test.ts — the parse suite is green.
- agent-judged: review approves the parser
phase store-records · deps parse-input
- executable: bun test src/store.test.ts — the store suite is green.
```

Вместо блока `knowledge:` ответ несёт одну строку, когда Knowledge нет:
`knowledge: none — phases were passed as text` (старт текстами),
`knowledge: none — specs/<slug>.md was absent at start` (архива не было на старте),
`knowledge: not recorded — the run started before schema v25` (старт до v25; фазы и done-when при
этом всё равно перечислены — они в событии старта с давних версий).

Ответ `workflow_spec { spec_slug }` — та же форма блока Knowledge и фаз, но из корпуса сейчас; без
архива — строка `knowledge: none — specs/<slug>.md is absent`:

```
Migrated spec "sample-spec" as it is in this corpus now. Nothing was written: no event, no file, no stale mark.
knowledge:
- **Rule.** read the archive across two lines.
- **Limit.** the base commit separates commits only.
phase parse-input · deps none
- executable: bun test src/parse.test.ts — the parse suite is green.
- agent-judged: review approves the parser
phase store-records · deps parse-input
- executable: bun test src/store.test.ts — the store suite is green.
```

Ответ `workflow_spec {}` — slug по алфавиту с числом фаз; пустой корпус отвечает одной строкой
`No spec is migrated in this corpus. Nothing was written.`:

```
Migrated specs in this corpus: 2. Nothing was written: no event, no file, no stale mark.
- other-spec · 1 phase
- sample-spec · 2 phases
```

Не-ответы — текст, журнал и корпус не меняются: id вне грамматики, неизвестный прогон, оба аргумента
сразу, slug вне грамматики, неизвестный slug (со списком мигрированных). Нечитаемый прогон отвечает
`Run <run_id> cannot be read from the log: <problem>. Nothing was written.`, фазовый файл или
Knowledge архива, которые не разбираются, — строкой с именем файла и причиной, папка с циклом в
зависимостях — `the phases of migrated spec "<slug>" do not form a graph: <reason>. Nothing was written.`:

```
run_id is not a ULID or UUID. Nothing was written.
No workflow run 01ARZ3NDEKTSV4RRFFQ69G5FA9 in this corpus. Nothing was written.
pass run_id or spec_slug, not both. Nothing was written.
spec slug "Sample_Spec" is not a slug: lowercase letters and digits separated by single dashes. Nothing was written.
no migrated spec "nowhere" in this corpus; migrated specs: other-spec, sample-spec. Nothing was written.
```

## Пределы

- Knowledge нормализована, а не побайтна: пункты такие, какими их отдаёт разбор спеки — строка
  продолжения приклеена к пункту через пробел, HTML-комментарии выкинуты. Это ровно та Knowledge,
  которую несут фазовые файлы, но не байты архива.
- Спека прогона не меняется от перемиграции: `{ run_id }` отдаёт Knowledge, какой её прочитал
  старт, даже если папку фаз удалили и мигрировали спеку заново; `{ spec_slug }` показывает новую.
- Базовый коммит отделяет коммиты прогона от прежних, но не незакоммиченные правки, лежавшие в
  дереве до старта: грязное дерево событие не записывает. Такие пути — решение человека.
- Прогон, начатый текстами (`phases`), Knowledge в событие не пишет: на resume её нет, как и раньше.

## Отдельная задача для mneme-plugin <!-- HANDOFF-RUN-SPEC-SKILLS -->

По порядку важности; здесь не делается:

1. **dev — Knowledge агенту.** Директива `execute_step` Knowledge не несёт. Сейчас агент видит её
   лишь потому, что dev на старте сам читает фазовые файлы; при старте по `spec_slug` этого чтения
   нет. dev вызывает `workflow_spec { run_id }` после старта и на resume и держит блок `knowledge:`
   в контексте работы фазы — resume получает Knowledge впервые. Без этого пункта старт по slug
   лишает агента Knowledge.
2. **dev SLUG-RESOLVE.** Форма `/mneme:dev <slug>`: `workflow_spec { spec_slug }` даёт id фаз для
   проверки `until <id>` и для раскладки `domains` в `recall_domains`, затем
   `workflow_start { spec_slug, steps, max_iterations, recall_domains? }` — без вычисления пути
   корпуса и без чтения фазовых файлов. Форма без пути (`/mneme:dev until <id>`) берёт список из
   `workflow_spec {}`. Явные пути и inline-тексты — как были: `phases`, и спека прогона — `spec none`.
3. **dev COMMIT-FIRST.** База прогона — из строки спеки `workflow_spec { run_id }`;
   `git diff --name-only <base>` даёт пути, изменённые с начала прогона. Пути, грязные ещё до
   старта, база не отделяет — их по-прежнему решает человек (`3 — сам`).
4. **map RUN-SPEC.** Шаги 2-5 (grep папки по id фаз, чтение архива) заменяет один
   `workflow_spec { run_id }`: блок `knowledge:` и done-when фаз берутся из ответа. Слово «дословно» —
   «как движок извлёк». Деградации — строки движка (`spec none`, `knowledge: not recorded …`).
5. **resume Step 4.** Граф фаз активного прогона — из `workflow_spec { run_id }` вместо grep папки
   фаз по id; строка «папка фаз не определена однозначно» больше не нужна.
6. **diary.** Строка спеки в ответе `diary_facts` — что ретро называет спеку прогона.
7. **Permissions.** `workflow_spec` — в разрешённых инструментах dev, map и resume.
