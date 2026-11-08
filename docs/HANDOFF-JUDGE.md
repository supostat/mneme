# HANDOFF: судья в дедупе — что меняется для скиллов плагина

Контракт для агента mneme-plugin. Движок получил СОВЕТНИКА: при `remember` и при `corpus_adopt` он
спрашивает Jev (TypeSafe System One — модель, которая отвечает на один типизированный вопрос
вероятностями, а не текстом) об отношении новой заметки к её ближайшему принятому соседу и
показывает ответ человеку рядом с косинусным сходством. Решение по-прежнему принимает человек через
`staging_resolve`; судья ничего не отбрасывает, не вливает и не ставит `supersedes`. Повод — пробник
на 597 парах корпусов mneme и mneme-plugin: косинусное предложение supersede попало 2 раза из 6 при
41 предложении, судья — 6 из 6 при 18. Скиллы здесь НЕ пишутся — документ перечисляет, что плагинной
стороне нужно отразить.

## Форма строки судьи <!-- HANDOFF-JUDGE-SHAPE -->

На карточке `staging_list` строка судьи стоит сразу ПОСЛЕ строки косинуса (`resembles <id>
(similarity 0.912)` или `no close neighbor`) и ПЕРЕД строкой `anchors:`. Три формы, ровно по
одной на карточку:

```
judge: supersedes 0.91 — recommends supersede of 01ARZ3NDEKTSV4RRFFQ69G5FAV
judge: complements 0.82 — supersede not recommended
judge: unavailable
```

- Первое слово после `judge: ` — отношение новой заметки A к соседу B, одно из пяти: `duplicate`,
  `supersedes`, `contradicts`, `complements`, `unrelated`; число — вероятность этого отношения.
- Хвост ` — recommends supersede of <id>` стоит, когда P(supersedes) + P(contradicts) ≥ 0,8 (порог
  спеки, не настройка); `<id>` — заметка, которую судья предлагает заменить. Она может НЕ совпадать
  со строкой косинуса: карточка с `no close neighbor` (сосед ниже порога предложения) всё равно
  несёт рекомендацию с id — именно там жили четыре из шести реальных supersede пробника.
- Хвост ` — supersede not recommended` — судья ответил, рекомендации нет.
- `judge: unavailable` — судья настроен, но не ответил (сеть, таймаут 3 с, не-2xx, испорченный
  ответ). Косинусная часть карточки при этом прежняя.
- Без настроенного судьи строки НЕТ: карточка побайтно прежняя.

Ответ `remember` при рекомендации меняет вторую строку:

```
Staged note 01ARZ3NDEKTSV4RRFFQ69G5FAW for human review.
The judge reads it as superseding 01ARZ3NDEKTSV4RRFFQ69G5FAV (supersedes 0.91); the human may choose to supersede that note.
Ask the human to review the queue with staging_list and decide accept, reject, or supersede.
```

Без рекомендации вторая строка прежняя (`It closely resembles …` / `No close existing note was
found.` / `Dedup ran in degraded mode …`).

Отчёт `corpus_adopt` получает по строке на каждую ВЛИТУЮ заметку с рекомендацией, перед последней
строкой отчёта: `judge flags <id> as supersedes (0.91) against <nearest>`. Заметка влита — у адопции
нет человеческого гейта по решению движка — а строка называет кандидата на `note_retire`.

Журнал: событие `remember` несёт `dedup.judge` (схема v24): `null` без судьи, иначе `{ model,
relation, probabilities, confidence, recommended, degraded }`; при `degraded: true` все поля ответа
`null`. Сосед — `dedup.nearest_id`, он реальный и для `add`. Событие `corpus_adopted` несёт
`judge_flagged_n`. Исход `dedup.outcome` судья не меняет никогда.

## Что править в скиллах mneme-plugin <!-- HANDOFF-JUDGE-SKILLS -->

- **dev**, **plan**, **fix** — BOUNDARY-CURATION и финальная курация: пометка «← рекомендую:
  supersede <id>» на заметке ставится ТОЛЬКО когда её строка судьи говорит `recommends supersede
  of <id>`, и только после VERIFY-BEFORE-ACCEPT по телу: прочитать обе заметки (staged — с
  карточки, `<id>` — через `notes_list { id }`) и убедиться, что новая действительно заменяет
  старую. Строка `supersede not recommended`, `judge: unavailable` и отсутствие строки
  рекомендацию supersede не дают — тогда действует прежнее правило по косинусу.
- Цифра supersede по рекомендации судьи вызывает `staging_resolve { decision: "supersede",
  supersede_target: <id> }` с тем же menu-payload, что и сегодня; движок сам ставит `suggested`
  по косинусному соседу, судья на это поле не влияет.
- Отчёт `corpus_adopt`: каждую строку `judge flags …` показать человеку как кандидата на
  `note_retire <nearest>` отдельным цифровым меню; автоматически ничего не ретирить.
- Конфиг: `judge{base_url, model}` в `.mneme.json` (дефолты — TypeSafe `https://api.typesafe.ai`
  и `jev-latest`; OpenRouter — `https://openrouter.ai/api` и `typesafe/jev-latest`), ключ ТОЛЬКО
  в переменной окружения `MNEME_JUDGE_API_KEY` процесса движка; `judge.api_key` в файле движок
  отвергает по имени. Судья включён ровно тогда, когда ключ задан. Тела заметок при этом уходят
  провайдеру — включение есть явное согласие владельца корпуса, `setup` должен сказать это словами.
- Диагностика: `bun scripts/doctor.ts` печатает компонент `judge`: `not configured
  (MNEME_JUDGE_API_KEY unset)`, `reachable, model <model>` или `degraded`. Недоступный судья —
  degraded, не fail: без него ничего не ломается.
- **design-server** и **resume** без изменений. Перепиновка: новая форма приходит с первым релизом
  движка после 0.1.19 (схема событий v24).
