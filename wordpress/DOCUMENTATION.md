# Smart Clover Bridge - WordPress Edition

Интелигентен мост между софтуера за управление на търговски обекти **"Детелина" (Microinvest)** и платформата за онлайн търговия **WooCommerce**.

---

## Архитектура (Docker Stack)

| Контейнер | Образ | Роля |
|-----------|-------|------|
| `clvr_wordpress` | `wordpress:6.5-php8.2-apache` | WooCommerce магазин |
| `clvr_db_wp` | `mariadb:10.11` | База данни за WordPress |
| `clvr_db_sync` | `postgres:15-alpine` | База данни за синхронизация |
| `clvr_ftp` | `stilliard/pure-ftpd:hardened` | FTP точка за обмен с Детелина |
| `clvr_sync_engine` | Custom Node.js | Логика на интеграцията |

### Docker мрежи

Услугите са изолирани в три мрежи:

- **`wp_net`** – WordPress ↔ MariaDB
- **`sync_net`** – Sync Engine ↔ PostgreSQL ↔ WordPress (API + webhook)
- **`ftp_net`** – Sync Engine ↔ FTP сървър

---

## Потоци на данни

### 1. Детелина → WooCommerce (Импорт)

Детелина качва XML файлове в `/transfer/in` чрез FTP. Sync Engine следи директорията с `chokidar` и обработва всеки нов файл.

#### PLUDATA – Номенклатура и цени

Формат: `<PLUDATA><PLU>...</PLU></PLUDATA>` (encoding: Windows-1251)

| XML поле | Действие |
|----------|----------|
| `PLUNB` | Вътрешен ID на артикула в Детелина; ключ за търсене в таблица `plu_mapping` |
| `PLUNM` | Наименование → WooCommerce `name` |
| `SLPRC` | Продажна цена → WooCommerce `regular_price` |
| `PLUNN` | Баркод / Външен код → WooCommerce `sku` |
| `DELETED=1` | Артикулът се деактивира (`status: trash`) |
| `GRP` | Вложена йерархия на групата → WooCommerce категория (създава се ако не съществува) |

Логиката е **upsert**: ако `PLUNB` вече е в `plu_mapping`, продуктът се обновява; иначе се създава нов и ID-то се записва.

#### POSSALES – Продажби от физически обект

Формат: `<POSSALES><RECEIPT>...</RECEIPT></POSSALES>`

За всяка касова бележка (`RECEIPT`) с `DEL=0`, за всеки `PLU` в нея:
1. Намира `wc_product_id` чрез `plu_mapping`
2. Намалява `stock_quantity` в WooCommerce с `QTY`

Анулирани бележки (`DEL=1`) се пропускат.

#### Idempotency

Всеки входящ файл се хешира (SHA-256) и se записва в таблица `processed_files`. Ако същият файл пристигне отново (напр. при повторно изпращане от Детелина), се пропуска без обработка.

#### Управление на грешки

- При грешка при обработка файлът се преименува на `.err`
- Грешката се записва в таблица `sync_errors` с timestamp

---

### 2. WooCommerce → Детелина (Експорт на поръчки)

Когато клиент плати поръчка в WooCommerce (статус `processing`), Sync Engine генерира RDELIV XML и го поставя в `/transfer/out/` за Детелина да го изтегли чрез FTP.

#### Механизъм – двустепенен

**Стъпка 1: Webhook (реално време)**

При старт Sync Engine автоматично регистрира WooCommerce webhook:
- **Topic:** `order.updated`
- **Delivery URL:** `http://sync_engine:3000/webhook/order` (вътрешна Docker мрежа)
- **Secret:** `WEBHOOK_SECRET` от `.env`

Когато WooCommerce изпрати webhook:
1. Sync Engine проверява HMAC-SHA256 подписа (`X-WC-Webhook-Signature`)
2. Отговаря с `HTTP 200` веднага (WooCommerce не изчаква обработката)
3. Ако `order.status === 'processing'` → извиква `exportOrder(order)` асинхронно

**Стъпка 2: Polling fallback (на всеки 2 минути)**

Търси поръчки със статус `processing` в WooCommerce и ги обработва. Улавя поръчки, пропуснати при евентуален downtime на webhook-а.

Двата механизма използват обща функция `exportOrder()` с idempotency проверка чрез таблица `exported_orders` – поръчката не може да се експортира два пъти.

#### RDELIV XML формат

```xml
<?xml version="1.0" encoding="WINDOWS-1251"?>
<RDELIV>
  <REQD>
    <TYP>1</TYP>              <!-- 1 = Заявка за доставка -->
    <SEIK>123456789</SEIK>    <!-- ЕИК от meta _billing_eik или billing.company -->
    <DNMB>738060663</DNMB>    <!-- WooCommerce Order ID -->
    <CMNT>WooCommerce order #738060663 – Иван Иванов</CMNT>
    <DDATE>20260306</DDATE>
    <DTIME>143022</DTIME>
    <STORG>1</STORG>
    <PLUES>
      <PLU>
        <PLUNB>920</PLUNB>         <!-- от meta _detelina_nb -->
        <PLUNN>60001832</PLUNN>    <!-- SKU -->
        <QTY>2.000</QTY>
        <PRC>5.00</PRC>
        <CURR>BGN</CURR>
        <PCMNT></PCMNT>
      </PLU>
    </PLUES>
  </REQD>
</RDELIV>
```

**ЕИК на клиента:** Sync Engine търси WordPress order meta с ключ `_billing_eik`. Ако липсва, използва `billing.company`. Препоръчително е да се добави поле за ЕИК в checkout формата чрез плъгин или custom код.

**Detelina PLUNB за продукт:** Sync Engine търси WordPress product meta с ключ `_detelina_nb`. Задава се автоматично при импорт на PLUDATA или ръчно в продуктовия редактор.

#### Имена на файловете

```
EboIn_Order{id}_{timestamp}.tmp   ← записва се като .tmp
EboIn_Order{id}_{timestamp}.xml   ← преименува се атомарно след пълно записване
```

Атомарното преименуване гарантира, че Детелина никога не чете частично записан файл.

#### Статус след експорт

След успешен експорт поръчката в WooCommerce се маркира като `on-hold`. Това предотвратява повторен експорт от polling цикъла.

---

## PostgreSQL схема

| Таблица | Описание |
|---------|---------|
| `processed_files` | SHA-256 хеш на всеки обработен входящ XML файл |
| `plu_mapping` | Детелина PLUNB ↔ WooCommerce product ID |
| `sync_errors` | Записи на грешки с timestamp |
| `exported_orders` | WooCommerce order ID ↔ XML файл (idempotency за изходящи) |

---

## Инструкции за инсталиране и стартиране

### Предварителни изисквания

На сървъра трябва да са инсталирани:

| Инструмент | Минимална версия | Проверка |
|------------|-----------------|----------|
| Docker Engine | 24+ | `docker --version` |
| Docker Compose (plugin) | 2.20+ | `docker compose version` |
| Git | всяка | `git --version` |

---

### Стъпка 1 – Клониране на репозиторито

```bash
git clone https://github.com/Andon-ov/Smart-clover-shop.git
cd Smart-clover-shop/wordpress
```

---

### Стъпка 2 – Конфигурация на средата

```bash
cp .env.example .env
nano .env          # или vim .env
```

Попълнете **всички** стойности:

```env
# Сменете всички пароли с реални, случайни стойности
MYSQL_ROOT_PASSWORD=...
MYSQL_DATABASE=wordpress
MYSQL_USER=...
MYSQL_PASSWORD=...

POSTGRES_DB=sync_bridge
POSTGRES_USER=...
POSTGRES_PASSWORD=...

FTP_PUBLIC_HOST=<IP на сървъра>   # вижте как да го намерите по-долу
FTP_USER_NAME=detelina
FTP_USER_PASS=...

# Тези два се попълват след стъпка 5!
WP_KEY=
WP_SECRET=

# Генерирайте с: openssl rand -base64 32
WEBHOOK_SECRET=...
```

> **Важно:** `FTP_PUBLIC_HOST` трябва да е публичният IP на сървъра, не `localhost`. Детелина ползва passive FTP и се свързва към него отвън.

#### Как да намерите публичния IP на сървъра

Влезте в сървъра по SSH и изпълнете една от следните команди:

```bash
# Метод 1 – през външна услуга (най-надежден)
curl -s ifconfig.me

# Метод 2 – алтернативна услуга
curl -s icanhazip.com

# Метод 3 – ако горните не работят (изисква инсталиран dnsutils)
dig +short myip.opendns.com @resolver1.opendns.com
```

Изходът ще бъде нещо от вида `94.26.xx.xx` – това е стойността, която трябва да се постави в `FTP_PUBLIC_HOST`.

> Ако сървърът е зад NAT (рядко при VPS), публичният IP се вижда в контролния панел на хостинг доставчика, а не от командния ред.

---

### Стъпка 3 – Първо стартиране на контейнерите

```bash
docker compose up -d
```

Проверете дали всички контейнери са стартирали успешно:

```bash
docker compose ps
```

Очакван резултат — всички услуги трябва да достигнат `healthy` или `running`:

```
NAME                STATUS
clvr_db_wp          healthy
clvr_db_sync        healthy
clvr_wordpress      healthy
clvr_ftp            running
clvr_sync_engine    running
```

> Контейнерите се стартират в правилен ред автоматично чрез `healthcheck` условия. `clvr_sync_engine` изчаква PostgreSQL и WordPress да са готови преди да стартира.

Ако даден контейнер не стартира, прегледайте логовете му:

```bash
docker compose logs clvr_sync_engine --tail=50
docker compose logs clvr_wordpress   --tail=50
```

---

### Стъпка 4 – Инсталиране на WordPress

1. Отворете `http://<IP-на-сървъра>:8082` в браузър
2. Изберете език и попълнете:
   - **Site Title** – напр. `Smart Clover Shop`
   - **Username / Password** – запомнете ги
   - **Email** – администраторски имейл
3. Натиснете **Install WordPress** и влезте в админ панела

---

### Стъпка 5 – Инсталиране и конфигурация на WooCommerce

1. В WordPress admin: **Plugins → Add New → Search** → намерете `WooCommerce` → **Install Now → Activate**
2. Преминете през Setup Wizard на WooCommerce (валута: BGN, страна: Bulgaria)
3. В **WooCommerce → Settings → Advanced → REST API** натиснете **Add Key**:
   - Description: `Sync Engine`
   - User: администраторът
   - Permissions: **Read/Write**
   - Натиснете **Generate API Key**
4. Копирайте **Consumer Key** и **Consumer Secret** в `.env`:
   ```env
   WP_KEY=ck_xxxxxxxxxxxxxxxxxxxx
   WP_SECRET=cs_xxxxxxxxxxxxxxxxxxxx
   ```

---

### Стъпка 6 – Свързване на Sync Engine с WooCommerce

След попълване на API ключовете рестартирайте Sync Engine:

```bash
docker compose restart sync_engine
```

При стартиране Sync Engine автоматично:
- изчаква PostgreSQL и WordPress да са достъпни
- създава PostgreSQL схемата (`processed_files`, `plu_mapping`, `sync_errors`, `exported_orders`)
- регистрира WooCommerce webhook за `order.updated`

Проверете логовете, за да потвърдите успешна инициализация:

```bash
docker compose logs sync_engine --tail=30
```

Очаквани редове:
```
[INFO] Database schema ready.
[INFO] Watching ./transfer/in for inbound XML files.
[INFO] Webhook server listening on :3000
[INFO] WooCommerce webhook registered → http://sync_engine:3000/webhook/order
[INFO] Order export poll interval: 120s
```

---

### Стъпка 7 – Конфигурация на Детелина

Настройте FTP плъгина в Детелина:

| Параметър | Стойност |
|-----------|---------|
| Host | публичният IP на сървъра |
| Port | `21` |
| User | стойността на `FTP_USER_NAME` от `.env` |
| Pass | стойността на `FTP_USER_PASS` от `.env` |
| Passive ports | `30000–30009` |
| Upload директория | `/in` |
| Download директория | `/out` |

> FTP passive режим използва портове `30000–30009`. Уверете се, че защитната стена на сървъра ги позволява заедно с порт `21`.

---

## Двупосочна комуникация с Детелина

### Посока 1 — Детелина → WooCommerce (внасяне на продукти)

#### Как работи

Детелина генерира PLUDATA XML файл и го качва в `/in` директорията чрез FTP. Sync Engine хваща файла в рамките на секунди, парсва го и прави upsert на продуктите в WooCommerce.

| XML поле | Задължително | Какво прави в WooCommerce |
|----------|-------------|--------------------------|
| `PLUNB` | ✅ | Уникален ID — ако вече е внесен, продуктът се **обновява**; иначе се **създава** |
| `PLUNM` | ✅ | Наименование на продукта |
| `SLPRC` | ✅ | Продажна цена (`regular_price`) |
| `PLUNN` | не | SKU / баркод |
| `DELETED` | не | `1` = деактивира продукта; `0` = публикуван |
| `GRP` → `GRP` → `GNМ` | не | Най-дълбоката група → WooCommerce категория (създава се автоматично) |

> **Внимание:** Буквата в тага `GNМ` е **кирилска М** (от оригиналния Детелина формат), не латинска.

#### Работещ XML шаблон

Детелина генерира файловете с `encoding="windows-1251"` — Sync Engine го разпознава и конвертира автоматично. При ръчно създаден файл може да се използва UTF-8:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PLUDATA>

  <PLU>
    <PLUNB>1</PLUNB>
    <PLUNN>BARCODE-001</PLUNN>
    <PLUNM>Тестов продукт 1</PLUNM>
    <SLPRC>19.99</SLPRC>
    <SLCUR>BGN</SLCUR>
    <DELETED>0</DELETED>
    <GRP>
      <GNМ>Козметика</GNМ>
      <GRP>
        <GNМ>Шампоани</GNМ>
      </GRP>
    </GRP>
  </PLU>

  <PLU>
    <PLUNB>2</PLUNB>
    <PLUNN>BARCODE-002</PLUNN>
    <PLUNM>Тестов продукт 2</PLUNM>
    <SLPRC>34.50</SLPRC>
    <SLCUR>BGN</SLCUR>
    <DELETED>0</DELETED>
    <GRP>
      <GNМ>Козметика</GNМ>
      <GRP>
        <GNМ>Маски</GNМ>
      </GRP>
    </GRP>
  </PLU>

</PLUDATA>
```

#### Как да пуснете файла

**Чрез FTP (реалният работен поток от Детелина):**

```
Host:              <IP на сървъра>
Port:              21
User:              стойността на FTP_USER_NAME от .env
Pass:              стойността на FTP_USER_PASS от .env
Режим:             Passive
Директория:        /in
```

**Директно на сървъра (за бърз тест):**

```bash
cp EboIn_PluData_test.xml ~/GitHub/Smart-clover-shop/wordpress/transfer/in/
```

#### Как да проверите резултата

```bash
docker compose -f ~/GitHub/Smart-clover-shop/wordpress/docker-compose.yml logs -f sync_engine
```

При успех:
```
[INFO] Processing inbound: EboIn_PluData_test.xml
[INFO] Created WC product #5 for PLU 1
[INFO] Created WC product #6 for PLU 2
[INFO] Done: EboIn_PluData_test.xml
```

Файлът изчезва от `transfer/in/` и се появява в `transfer/archive/`. При грешка се преименува на `.err`.

---

### Посока 2 — WooCommerce → Детелина (изпращане на поръчки)

#### Как работи

Когато клиент плати поръчка в WooCommerce (статус `processing`), Sync Engine:

1. Получава веднага известие чрез WooCommerce webhook (`order.updated`)
2. Генерира RDELIV XML файл
3. Записва го в `transfer/out/` като `.tmp`, след което го преименува атомарно на `.xml`
4. Детелина го изтегля от `/out` директорията чрез FTP
5. Поръчката в WooCommerce се маркира като `on-hold`

Ако webhook-ът е бил недостъпен, polling fallback проверява за нови поръчки на всеки 2 минути.

#### Необходими мета данни в поръчката

За да се генерира коректен RDELIV XML, продуктите в WooCommerce трябва да имат записан Детелина вътрешен код. Той се задава автоматично при PLUDATA импорт и се съхранява като WordPress product meta:

| Meta ключ | Стойност | Откъде идва |
|-----------|---------|-------------|
| `_detelina_nb` | `PLUNB` на артикула | Задава се автоматично при PLUDATA импорт |
| `_billing_eik` | ЕИК на клиента | Добавя се в checkout формата чрез плъгин |

> Ако `_billing_eik` липсва, за SEIK се използва `billing.company` от поръчката. Препоръчително е да се добави поле за ЕИК в checkout формата чрез плъгин (напр. **Flexible Checkout Fields for WooCommerce**).

#### Структура на генерирания файл

```
transfer/out/EboIn_Order{wc_id}_{timestamp}.xml
```

```xml
<?xml version="1.0" encoding="WINDOWS-1251"?>
<RDELIV>
  <REQD>
    <TYP>1</TYP>
    <SEIK>123456789</SEIK>
    <DNMB>42</DNMB>
    <CMNT>WooCommerce order #42 – Иван Иванов</CMNT>
    <DDATE>20260306</DDATE>
    <DTIME>143022</DTIME>
    <STORG>1</STORG>
    <PLUES>
      <PLU>
        <PLUNB>1</PLUNB>
        <PLUNN>BARCODE-001</PLUNN>
        <QTY>2.000</QTY>
        <PRC>19.99</PRC>
        <CURR>BGN</CURR>
        <PCMNT></PCMNT>
      </PLU>
    </PLUES>
  </REQD>
</RDELIV>
```

#### Конфигурация на Детелина за изтегляне на поръчки

В Детелина настройте периодично изтегляне от FTP директорията `/out`. Обработеният файл се преименува от Детелина на `.proc` след успешен импорт.



```bash
# Спиране на всички контейнери на проекта
docker compose down

# Спиране и изтриване на данните (ВНИМАНИЕ: изтрива базите!)
docker compose down -v

# Преглед на логове в реално време
docker compose logs -f

# Логове само на sync engine
docker compose logs -f sync_engine

# Рестартиране на конкретен контейнер
docker compose restart sync_engine

# Обновяване след промяна на код в sync-engine/
docker compose build sync_engine
docker compose up -d sync_engine
```

---

## Структура на папките

```
wordpress/
├── .env.example          ← шаблон за конфигурация
├── .env                  ← локална конфигурация (не се commit-ва)
├── docker-compose.yml
├── DOCUMENTATION.md
├── docker/
│   ├── mysql_data/       ← MariaDB данни (не се commit-ват)
│   └── postgres_data/    ← PostgreSQL данни (не се commit-ват)
├── sync-engine/
│   ├── index.js          ← основна логика
│   ├── package.json
│   └── Dockerfile
├── transfer/
│   ├── in/               ← Детелина качва XML тук (FTP)
│   ├── out/              ← Sync Engine поставя RDELIV XML тук
│   └── archive/          ← успешно обработени входящи файлове
└── wp-content/           ← теми, плъгини, снимки (персистентни)
```

---

## Управление на грешки

| Сценарий | Поведение |
|----------|-----------|
| Невалиден XML от Детелина | Файлът се преименува на `.err`; грешката се записва в `sync_errors` |
| Дублиран файл (същи SHA-256) | Пропуска се; файлът се архивира |
| WooCommerce API грешка | Грешката се логва; файлът остава за ретри при следващо стартиране |
| Невалиден webhook подпис | HTTP 401; логва се предупреждение |
| Webhook downtime | Polling fallback улавя пропуснатите поръчки на всеки 2 минути |
| Partial file write | `.tmp` → `.xml` rename е атомарен; Детелина никога не вижда непълен файл |

