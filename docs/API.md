# Локальный API

Префикс `/api/v1`. Тела изменений — JSON, `Content-Type: application/json`, браузерный `Origin` должен совпадать с `Host`. Допустимый Host: `localhost`, `127.0.0.1`, `[::1]`. Ответ ошибки: `code`, `message`, `requestId`, `retryable`, при валидации также `fields`. `ownerId` не передается клиентом.

| Путь | Методы | Назначение |
| --- | --- | --- |
| `/settings` | GET, PATCH | Тема, модель по умолчанию, редакция инструкций |
| `/settings/credential` | POST, DELETE | Записать/удалить ключ; GET `/settings` показывает только маску |
| `/providers/check` | POST | Проверить сохраненный ключ без генерации |
| `/providers/models` | GET | Каталог OpenRouter, кеш 1 час |
| `/instructions` | POST | Новая неизменяемая редакция пяти рабочих инструкций |
| `/projects` | GET, POST | Список и создание с пятью пустыми слотами |
| `/projects/{id}` | GET, PATCH, DELETE | Проект, архив и удаление |
| `/projects/{id}/cycles` | POST | Новый цикл с копиями исходников |
| `/cycles/{id}` | GET | Рабочее состояние, разборы, версии, предложения |
| `/cycles/{id}/config` | PATCH | Модель и снимок инструкций до первого анализа |
| `/cycles/{id}/references` | POST | Добавить референс |
| `/references/{id}` | PATCH | Поля и новая текстовая ревизия, архив |
| `/references/{id}/duplicate` | POST | Копия текущего текста без старого разбора |
| `/references/{id}/analyses` | POST | Независимый разбор; `depth`: `brief`, `detailed`, `deep` |
| `/cycles/{id}/selection` | PATCH | Выбор конкретного элемента |
| `/cycles/{id}/selection-settings` | PATCH | Пожелания и ограничения |
| `/cycles/{id}/assemblies` | POST | Предложение полной инструкции |
| `/cycles/{id}/prompt-versions` | POST | Предложение промпт-версии |
| `/cycles/{id}/proposals/{id}` | PATCH | Применение предложения с ревизией |
| `/cycles/{id}/draft` | PATCH | Ручная правка точного текста |
| `/cycles/{id}/checks` | POST | Необязательная проверка документа |
| `/cycles/{id}/samples` | POST | Одна проба выбранного документа |
| `/cycles/{id}/versions` | POST | Неизменяемый снимок текущего состояния |
| `/versions/{id}/continue` | POST | Отдельный цикл из сохраненной версии |
| `/cycles/{id}/usage` | GET | Токены попыток и полнота сведений |
| `/exports?cycleId=…&kind=full\|prompt&format=md\|txt` | GET | Точный видимый текст без вызова ИИ |
| `/jobs/{id}` | GET | Состояние задания |
| `/jobs/{id}/cancel` | PATCH | Запрос отмены |
| `/api/health/live`, `/api/health/ready` | GET | Проверки контейнера и БД (без префикса v1) |

Для запуска ИИ, создания версии и применения предложения нужен заголовок `Idempotency-Key` с новым UUID. Повтор того же ключа и тела возвращает прежний ответ. При другом теле — `409`. Редактирование требует `expectedRevision` соответствующего объекта. Длинная операция возвращает `jobId` и HTTP 202. Состояния: `queued`, `running`, `succeeded`, `failed`, `cancel_requested`, `canceled`.

Референс до 200 000 символов, запрос до 2 MiB. Проверка контекста оценивает токены с резервом; для модели с неизвестным пределом оценка остается неопределенной. Тексты никогда не сокращаются молча. Тестовый адаптер включается только `AI_ADAPTER=test` и должен быть явно виден в интерфейсе.
