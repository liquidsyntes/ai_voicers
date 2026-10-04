# Локальный HTTP API

Этот справочник описывает реализованные маршруты. Базовый адрес при настройках Compose по умолчанию: `http://127.0.0.1:3333/api/v1`. Интерфейс вызывает их через [`src/lib/client.ts`](../src/lib/client.ts). Пользовательский сценарий описан в [руководстве](USER-GUIDE.md), внутренний путь запроса — в [архитектуре](ARCHITECTURE.md).

## Общие правила

- Для изменяющих запросов используйте `Content-Type: application/json` и `Origin: http://127.0.0.1:3333` (или точный адрес, с которого открыт интерфейс). Сервер проверяет совпадение `Origin` и `Host`; доступ рассчитан на `localhost` и `127.0.0.1`. `ownerId` не передается: приложение использует внутреннего локального владельца.
- Редактирование существующего объекта обычно требует `expectedRevision`. Несовпадение возвращает HTTP 409 `REVISION_CONFLICT`. Возьмите новую ревизию из GET и решите конфликт явно.
- Для операций с генерацией, ручного создания и правки правил, сохранения версии и применения предложения требуется заголовок `Idempotency-Key` с новым уникальным значением. Один и тот же ключ с тем же методом, путем и телом возвращает прежний ответ; с другим содержимым — HTTP 409 `IDEMPOTENCY_CONFLICT`. Пока исходный запрос выполняется, возможен `REQUEST_IN_PROGRESS`.
- Длинные операции возвращают HTTP 202 и `{ "jobId": "…", "state": "queued" }`. Получайте статус через `/jobs/{id}` или `GET /cycles/{id}`. Ошибка обычно имеет `code`, `message`, `requestId`, `retryable`; при проверке полей добавляется `fields`.
- Общий предел тела запроса — 2 MiB; текст одного референса — до 200 000 символов. Тексты не сокращаются молча. Ответы API имеют `Cache-Control: no-store`.

Пример чтения проектов из PowerShell:

```powershell
$base = 'http://127.0.0.1:3333'
Invoke-RestMethod "$base/api/v1/projects"
```

Пример создания проекта. Замените `provider/model` на действительный model ID; запрос действительно добавит данные в локальную БД:

```powershell
$base = 'http://127.0.0.1:3333'
$body = @{ name = 'Пробный проект'; modelId = 'provider/model' } | ConvertTo-Json
Invoke-RestMethod -Uri "$base/api/v1/projects" -Method Post -ContentType 'application/json' -Headers @{ Origin = $base } -Body $body
```

## Настройки и провайдер

| Метод и путь | Тело / результат |
| --- | --- |
| `GET /settings` | Настройки, маска ключа, список редакций, стандартные шаблоны и активный адаптер. Полный ключ не возвращается. |
| `PATCH /settings` | `expectedRevision` и одно или несколько полей: `theme` (`light`/`dark`), `defaultModel`, `defaultModelContext`, `defaultReasoningEffort` (`auto`/`low`/`high`/`max`), `instructionId`. |
| `POST /settings/credential` | `{ "key": "…" }`; шифрует и заменяет ключ, возвращает маску. |
| `DELETE /settings/credential` | Удаляет сохраненную запись ключа. |
| `POST /providers/check` | Проверка сохраненного ключа через OpenRouter `/api/v1/key`; генерации нет. |
| `GET /providers/models` | Каталог текстовых моделей OpenRouter с `id`, `name`, `contextLength`; сервер использует кеш до часа. |
| `POST /instructions` | `{ "name": "…", "content": {…} }`; создает новую редакцию шести рабочих инструкций и выбирает ее для новых циклов. |

`content` содержит строки `analyze`, `rules`, `assemble`, `prompt`, `check`, `sample`. Допустимые переменные: `analyze` — `{{depth}}`, `{{word_count}}`; `rules` и `assemble` — `{{selected_count}}`; `prompt`, `check`, `sample` — `{{document_length}}`. Неизвестная переменная отклоняется. Для старой редакции без `rules` сервер подставляет стандартный шаблон этого шага при создании цикла метода 2. В текущей реализации `{{selected_count}}` в шаблоне `assemble` считает массив `selected` старого метода и выводит `0` для входа метода 2 с массивом `rules`; на это значение в собственной редакции инструкции пока не следует опираться.

## Проекты, циклы и референсы

| Метод и путь | Назначение |
| --- | --- |
| `GET /projects` | Список проектов и краткая информация о циклах. Архивные проекты тоже возвращаются; главная страница скрывает их своим фильтром. |
| `POST /projects` | `{ "name": "…", "modelId": "provider/model" }`; создает проект, цикл метода 2 и пять пустых референсов. Необязательные `modelContext` и `reasoningEffort` уточняют модель. |
| `GET /projects/{id}` | Проект с циклами. |
| `PATCH /projects/{id}` | `expectedRevision`, `name` и/или `archived`. |
| `DELETE /projects/{id}` | Необратимо удаляет проект с зависимыми данными. |
| `POST /projects/{id}/cycles` | `sourceCycleId`, необязательные `modelId`, `modelContext`, `reasoningEffort`; создает цикл метода 2 с копиями неархивных текущих текстов и ролей, без анализов. |
| `GET /cycles/{id}` | Рабочий цикл, текущие тексты, разборы, правила, группы, предложения, версии, проверки, пробы и последние 25 заданий. Полный input задания из этого ответа исключен. |
| `PATCH /cycles/{id}/config` | `expectedRevision`, модель, контекст, уровень рассуждения и/или редакция инструкций. Доступно до фиксации цикла. |
| `POST /cycles/{id}/references` | Создает источник: `title`, необязательные `text`, `sourceRole`, `author`, `note`, `focus`. |
| `PATCH /references/{id}` | `expectedRevision` и изменяемые поля, включая `text`, `sourceRole`, `archived`. При изменении текста создается новая редакция. |
| `POST /references/{id}/duplicate` | Копирует текущий текст и метаданные без анализа. |
| `POST /references/{id}/analyses` | `{ "depth": "brief|detailed|deep" }`; отдельное задание анализа текущей редакции. Требует `Idempotency-Key`. |

`sourceRole`: `own` (мой голос), `inspiration` (ориентир), `unspecified` (без роли). У анализа метода 2 появляются `portrait` и `transferability` каждого элемента: `form`, `topic` либо `mixed`. `GET /cycles/{id}` возвращает историю анализов, но только текущую редакцию текста для каждого референса; источник прошлой редакции не подменяет актуальный разбор.

## Выбор приемов и правила метода 2

| Метод и путь | Назначение |
| --- | --- |
| `PATCH /cycles/{id}/selection` | Выбор одного элемента. `analysisId`, `elementId`, `state` (`selected`, `deferred`, `excluded`, `unreviewed`); для существующей записи `expectedRevision`. Возможны `role`, `strength`, `frequency`, `condition`. |
| `PATCH /cycles/{id}/selection-settings` | `expectedRevision`, `wishes` и массив `constraints` вида `{ "kind": "soft|ban", "text": "…" }`. |
| `POST /cycles/{id}/rules` | `{ "expectedRevision": N }`; задание формирования кандидатов из актуальных выбранных приемов, пожеланий и ограничений. Отдельные поля исходника, цитат и автора в input не включаются. Требует `Idempotency-Key`; при пустом наборе оснований возвращает `RULE_SOURCES_EMPTY`. |
| `POST /cycles/{id}/manual-rules` | Создает собственное не связанное с группой правило. Требует `Idempotency-Key`. |
| `PATCH /rules/{id}` | Правит правило с `expectedRevision`; требует `Idempotency-Key`. |
| `GET /rules/{id}/revisions` | История сохраненных редакций правила, начиная с последней. |

Тело собственного правила:

```json
{
  "rule": {
    "text": "Избегай претенциозных формулировок",
    "direction": "dont",
    "severity": "soft",
    "category": "Тон",
    "condition": "",
    "selected": false
  }
}
```

Для `direction: "do"` значение `severity` должно быть `none`. Для `direction: "dont"` допустимы `soft` и `ban`. `selected` определяет участие в сборке; снятие выбора не меняет направление и не создает запрет. `PATCH /rules/{id}` принимает только `text`, `direction`, `severity`, `category`, `condition`, `selected`, `archived` и обязательную ревизию. Правка сохраняет новую `RuleRevision`; `archived` скрывает правило из рабочего списка без удаления его истории.

`GET /cycles/{id}` добавляет `ruleBatches` со снимками оснований, кандидатами и вычисленным `stale`, а также `ruleWarnings`. `stale=true` означает, что текущий набор источников для генерации отличается от сохраненного при создании группы. Предыдущие правила не удаляются. `ruleWarnings` сегодня проверяет только совпадающие выбранные формулировки и один и тот же текст в двух направлениях; смысловые противоречия он не распознает.

## Документы, проверка и версии

| Метод и путь | Назначение |
| --- | --- |
| `POST /cycles/{id}/assemblies` | Задание создания предложения полной инструкции. Метод 2 передает только отмеченные неархивные правила; без них возвращает `SELECT_RULES_FIRST`. Старый метод передает выбранные приемы и пожелания напрямую. |
| `POST /cycles/{id}/prompt-versions` | Задание создания промпт-версии из точного текущего полного текста; пустой текст дает `FULL_EMPTY`. |
| `PATCH /cycles/{id}/proposals/{proposalId}` | Применяет предложение к полному тексту или промпту. `expectedRevision` документа, необязательный исправленный `text`, `Idempotency-Key`. |
| `PATCH /cycles/{id}/draft` | Сохраняет ручную правку: `{ "kind": "full|prompt", "text": "…", "expectedRevision": N }`. |
| `POST /cycles/{id}/checks` | Необязательное задание проверки: `{ "document": "full|prompt" }`. |
| `POST /cycles/{id}/samples` | Одна текстовая проба: `document`, `situation`, `words` (50–500, по умолчанию 200). |
| `PATCH /samples/{id}` | Обновляет комментарий к пробе. |
| `POST /cycles/{id}/versions` | `{ "name": "…", "expectedRevision": N }`; неизменяемый снимок текущего цикла, `Idempotency-Key`. Проверка и проба не требуются. |
| `POST /versions/{id}/continue` | Создает отдельный рабочий цикл из снимка версии. |
| `GET /exports?cycleId=…&kind=full|prompt&format=md|txt` | Скачивает точный сохраненный текст без вызова ИИ. Пустой документ дает `DOCUMENT_EMPTY`. |

Сборка и другие задания генерации требуют `Idempotency-Key`. Результат сборки и промпта сначала попадает в `Proposal`. Рабочий текст не заменяется до `PATCH /proposals/{id}`. Промпт помечается устаревшим, когда сохраненный `promptSourceHash` не равен хешу текущего полного текста. Вручную введенный промпт без `promptSourceHash` тоже получает эту пометку. Его текст продолжает храниться и экспортироваться. Проверка привязана к хешу точного текста документа; ее устаревание не запрещает другие операции.

## Задания и usage

| Метод и путь | Назначение |
| --- | --- |
| `GET /jobs/{id}` | `state`, фактический `stage`, `startedAt`, `lastProgressAt`, `progressChars`, `attemptCount`, ошибка и итоговые метаданные. Исходный input скрыт. |
| `PATCH /jobs/{id}/cancel` | Отменяет ожидающее задание или запрашивает остановку текущего. |
| `GET /cycles/{id}/usage` | Сумма `inputTokens`, `outputTokens`, `totalTokens`, число попыток и флаг `complete`. При неполных данных соответствующая сумма равна `null`, а не нулю. |

Основные состояния: `queued`, `running`, `cancel_requested`, `canceled`, `succeeded`, `failed`. Объем полученного ответа — число символов, не процент готовности. Прерванный запрос может быть уже учтен провайдером даже при отсутствии завершенного результата.

## Ошибки и health endpoints

Пример ошибки:

```json
{
  "code": "REVISION_CONFLICT",
  "message": "REVISION_CONFLICT",
  "requestId": "…",
  "retryable": false
}
```

Частые коды: `INVALID_INPUT` (422), `CONTEXT_EXCEEDED` (422 с оценкой и лимитом), `STALE_ANALYSIS` (409), `CYCLE_LOCKED` (409), `RULE_SOURCES_EMPTY` (422), `SELECT_RULES_FIRST` (422), `KEY_MISSING` (422 или ошибка фонового задания), `KEY_INVALID`, `QUEUE_FULL` (429), `QUEUE_UNAVAILABLE` (503). Ошибки OpenRouter, неверный JSON и таймаут фонового задания отражаются в `AiJob.errorCode`; исходный текст остается сохраненным.

`GET /api/health/live` и `GET /api/health/ready` находятся **вне** префикса `/api/v1`. Первый показывает доступность веб-процесса; второй также проверяет БД и недавний heartbeat worker.
