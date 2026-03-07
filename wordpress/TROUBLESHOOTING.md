# Troubleshooting Guide — Smart Clover Shop Sync Bridge

Проблемите, срещнати при първоначалното пускане на системата (07.03.2026), и техните решения.
При ново изграждане от нулата — прегледай тези точки преди да търсиш другаде.

---

## 1. WooCommerce REST API връща 401 Unauthorized

### Симптом
```
sync_engine | AxiosError: Request failed with status code 401
```

### Причини и решения

#### 1а. Apache изтрива `Authorization` хедъра
Apache по подразбиране не предава `Authorization` хедъра към PHP/WordPress.  
**Решение:** Използвай query params вместо Basic Auth:
```
/wp-json/wc/v3/orders?consumer_key=ck_...&consumer_secret=cs_...
```
Вижи функцията `wcApi()` в `sync-engine/index.js`.

#### 1б. WooCommerce изисква HTTPS за query param автентикация
WC отказва query param auth ако заявката не е по HTTPS.  
**Решение:** Добави хедър `X-Forwarded-Proto: https` към всички заявки към WC API:
```javascript
headers: { 'X-Forwarded-Proto': 'https' }
```

#### 1в. `woocommerce_api_enabled` е `no` в базата
Дори с верни ключове API-то може да е изключено.  
**Диагноза:**
```bash
docker exec clvr_db_wp mysql -u wp_user -pchange_me_wp wordpress \
  -e "SELECT option_value FROM wp_options WHERE option_name='woocommerce_api_enabled';"
```
**Решение:**
```bash
docker exec clvr_db_wp mysql -u wp_user -pchange_me_wp wordpress \
  -e "UPDATE wp_options SET option_value='yes' WHERE option_name='woocommerce_api_enabled';"
```
Или в WordPress Admin → WooCommerce → Settings → Advanced → Legacy API → Enable.

#### 1г. Hash на consumer_key не съвпада в базата
WooCommerce пази HMAC-SHA256 хеш на ключа, не самия ключ.  
**Диагноза:**
```bash
docker exec clvr_db_wp mysql -u wp_user -pchange_me_wp wordpress \
  -e "SELECT consumer_key, consumer_secret FROM wp_woocommerce_api_keys LIMIT 5;"
```
**Решение:** Изчисли правилния хеш и го запиши директно:
```bash
docker exec clvr_wordpress php -r "echo hash_hmac('sha256', 'ck_ТВОЯ_КЛЮЧ', 'wc-api');"
```
След това:
```bash
docker exec clvr_db_wp mysql -u wp_user -pchange_me_wp wordpress \
  -e "UPDATE wp_woocommerce_api_keys SET consumer_key='ХЕША' WHERE key_id=1;"
```

---

## 2. FTP — `Rename/move failure` (550 грешка)

### Симптом
```
[DoUpload]Rename/move failure
[TOutboundHandler]Can't upload files from FTP. Exiting.
```
FTP протоколът връща `550` на `RNFR` команда.

### Причина
Образът `stilliard/pure-ftpd:hardened` е компилиран **без поддръжка на rename** (`--without-rename`). Няма конфигурационен файл, който да го включи обратно — проблемът е на ниво бинарен файл.

### Решение
Използвай `stilliard/pure-ftpd:latest` вместо `hardened` в `docker-compose.yml`:
```yaml
ftp_server:
  image: stilliard/pure-ftpd:latest   # НЕ :hardened
```

### Проверка
```bash
echo "test" > /tmp/t.tm~
curl -v --user "detelina:change_me_ftp" \
  -T /tmp/t.tm~ "ftp://127.0.0.1/t.tm~" \
  -Q "-RNFR t.tm~" -Q "-RNTO t.xml" 2>&1 | grep -E "250|550"
# Очаквано: 250 File successfully renamed or moved
```

---

## 3. FTP — Connect timed out от публичния IP

### Симптом
```
[CheckConnection]FTP:Connect timed out.
[TOutboundHandler]Can't connect to FTP :213.91.179.101/21. Exiting.
```

### Причина
Проблемът е извън кода — рутерът или ISP-то.

### Диагноза
```bash
# Тест от самия сървър към публичния IP
curl -v ftp://213.91.179.101/ --user "detelina:change_me_ftp" 2>&1 | head -5
```
- Ако се свърже → рутерът работи, проблемът е интермитентен (rebuild на контейнера по времето на опита)
- Ако timeout → провери port forwarding правилото в рутера: порт 21 → `192.168.1.41`
- Ако рутерът е наред но timeout продължава → ISP блокира входящ порт 21 (много честа практика)

### Решение при блокиран порт 21 от ISP
Смени FTP порта на нестандартен (напр. 2121) в `docker-compose.yml`:
```yaml
ports:
  - "2121:21"
```
И конфигурирай Detelina да се свързва на порт 2121.

---

## 4. chokidar не засича файлове в Docker volume

### Симптом
Файл се качва в `transfer/`, но sync_engine не го обработва. Няма лог. `touch` на файла не предизвиква нищо.

### Причина
chokidar разчита на `inotify` (Linux kernel events). При Docker volume mount, файловете се пишат от хост процес (FTP контейнер) с различен inode namespace — kernel events не достигат до контейнера на sync_engine.

### Решение
Добави `usePolling: true` в chokidar конфигурацията в `sync-engine/index.js`:
```javascript
const watcher = chokidar.watch(CONFIG.transfer.inDir, {
  usePolling: true,  // задължително при Docker volume mounts
  interval:   3000,  // poll на всеки 3 секунди
  // ...
});
```

---

## 5. Кирилицата се чупи (encoding проблем)

### Симптом
Имена на продукти и категории се показват като безсмислени символи вместо кирилица.

### Причина
Файловете от Detelina са в **Windows-1251** кодировка. XML декларацията може да е `encoding="Windows-1251"` (с главна W) или `encoding="WINDOWS-1251"`. Проверката в кода беше case-sensitive (`includes('windows-1251')`) и пропускаше главните букви — файлът се четеше като UTF-8, което руши кирилицата.

### Решение
Използвай case-insensitive regex при детекция:
```javascript
// ГРЕШНО:
xmlString = rawBuffer.toString('ascii').includes('windows-1251')
  ? iconv.decode(rawBuffer, 'win1251')
  : rawBuffer.toString('utf8');

// ПРАВИЛНО:
xmlString = /windows-1251/i.test(rawBuffer.toString('ascii', 0, 500))
  ? iconv.decode(rawBuffer, 'win1251')
  : rawBuffer.toString('utf8');
```

---

## 6. Права на директории за FTP

### Симптом
FTP upload успява, но файлът не се появява или rename/archive в sync_engine се проваля.

### Причина
Директориите `transfer/`, `transfer/archive/`, `transfer/out/` са собственост на `server:server` но FTP контейнерът пише с UID 1000 (`ftpuser`). Ако правата са рестриктивни, записването се проваля.

### Решение
```bash
cd ~/GitHub/Smart-clover-shop/wordpress
chmod 777 transfer/ transfer/archive/ transfer/out/ transfer/in/
```

---

## 7. RDELIV генериран с `<SEIK>0</SEIK>`

### Симптом
Генерираният XML файл за поръчка съдържа `<SEIK>0</SEIK>`. Detelina не може да обработи заявката защото контрагентът с ЕИК `0` не съществува в системата.

```xml
<SEIK>0</SEIK>
```

### Причина
Кодът търсеше ЕИК само в:
1. Мета поле `_billing_eik` на поръчката (попълва се ако има специален checkout field)
2. `billing.company` поле (попълва се само ако клиентът е въвел фирма)

При поръчка от физическо лице без фирма — нито едното е налично → `SEIK=0`.

### Решение
Три нива на fallback в `buildRdelivXml()`:

1. **Мета поле `_billing_eik`** на поръчката (custom checkout field)
2. **Търсене по email** в таблицата `customers` — попълва се автоматично при обработка на `CUSTOMERS` файл от Detelina
3. **`DEFAULT_CUSTOMER_EIK`** env var — ЕИК на generic контрагент в Detelina за онлайн клиенти без ЕИК

```bash
# В .env на сървъра добави:
DEFAULT_CUSTOMER_EIK=123456789   # ЕИК на "Онлайн клиент" контрагент в Detelina
```

```yaml
# docker-compose.yml вече го предава:
DEFAULT_CUSTOMER_EIK: ${DEFAULT_CUSTOMER_EIK:-0}
```

### CUSTOMERS файл — как работи процесът
Detelina изнася файл с контрагенти (`CUSTOMERS` XML формат). Sync engine-ът го обработва и записва `EIK` + `EMAIL` в PostgreSQL таблица `customers`. При следваща поръчка — търси ЕИК по email на клиента.

**Важно:** Контрагентът трябва да има попълнен `EMAIL` в Detelina за да работи автоматичното търсене. Ако нямат email в системата → използва се `DEFAULT_CUSTOMER_EIK`.

### Диагноза — проверка дали клиентът е в базата
```bash
docker exec clvr_db_sync psql -U sync_user -d sync_db \
  -c "SELECT eik, name, email FROM customers WHERE LOWER(email) = 'email@example.com';"
```

---

## 8. `?` вместо специален символ в CMNT полето на RDELIV

### Симптом
```xml
<CMNT>WooCommerce order #3246 ? Andon Andonov</CMNT>
```
Въпросителен знак вместо тире между номера на поръчката и името.

### Причина
В кода беше използвано Unicode en-dash (`–`, U+2013). Когато `iconv-lite` encode-ва текста към `windows-1251`, символът U+2013 не съществува в тази кодова таблица и се заменя с `?`.

### Решение
Замени en-dash с обикновено ASCII тире `-`:
```javascript
// ГРЕШНО (en-dash не е в windows-1251):
`WooCommerce order #${order.id} – ${name}`

// ПРАВИЛНО (обикновено ASCII тире):
`WooCommerce order #${order.id} - ${name}`
```

**Правило:** В низове, които се encode-ват към `windows-1251`, използвай само ASCII символи или кирилица. Всички типографски символи (em-dash, en-dash, smart quotes, ellipsis…) трябва да се заменят с ASCII еквивалент.

---

## 9. Продуктите пак показват чупена кирилица след encoding fix

### Симптом
Encoding fix-ът е deploy-нат, контейнерът е рестартиран, но WooCommerce продуктите все още показват `?` вместо кирилица.

### Причина
Idempotency механизмът. Sync engine пази SHA-256 хеш на всеки обработен файл в таблица `processed_files`. При второ пускане на същия файл — хешът съвпада и файлът се **пропуска**. Счупените данни вече са записани в WooCommerce и не се презаписват.

### Решение
Изтрий записите от `processed_files` и върни файловете от archive → ще се преработят наново с правилния encoding и ще UPDATE-нат съществуващите продукти (не се дублират — `plu_mapping` пази `wc_product_id`):

```bash
cd ~/GitHub/Smart-clover-shop/wordpress

# 1. Изчисти историята за обработените файлове
docker exec clvr_db_sync psql -U sync_user -d sync_db \
  -c "DELETE FROM processed_files;"

# 2. Върни архивираните файлове обратно в transfer/
mv transfer/archive/*.xml transfer/ 2>/dev/null
mv transfer/archive/*.tm~ transfer/ 2>/dev/null

# 3. Провери дали файловете са налице
ls -la transfer/

# 4. Следи логовете — трябва да видиш "Updated WC product" редове
docker compose logs -f sync_engine
```

**Резултат:** Sync engine-ът прави `PUT` (update) към съществуващите WC продукти — имената се оправят без дублиране.

---

## 10. Дублирани файлове предизвикват crash (duplicate SHA256)

### Симптом
```
sync_engine | ERROR: duplicate key value violates unique constraint "processed_files_sha256_key"
```
Sync engine crash-ва и спира да обработва файлове.

### Причина
Ако Detelina качи идентичен файл два пъти (или файл бъде копиран ръчно обратно от archive), SHA-256 хешът вече съществува в `processed_files`. `INSERT` без `ON CONFLICT` хвърля грешка.

### Решение
Добави `ON CONFLICT (sha256) DO NOTHING` на INSERT-а:
```javascript
await pool.query(
  `INSERT INTO processed_files (filename, sha256, doc_type) VALUES ($1, $2, $3)
   ON CONFLICT (sha256) DO NOTHING`,
  [filename, hash, docType]
);
```
Файлът се архивира без грешка — логва се `Skipping duplicate file:`.

---

## 11. PLUNB=0 в генерирания RDELIV XML

### Симптом
```xml
<PLUNB>0</PLUNB>
```
Detelina не може да обработи заявката, защото артикул с вътрешен код `0` не съществува.

### Причина
`buildRdelivXml()` търсеше `detelina_nb` в `plu_mapping` само по `wc_product_id`. Ако продуктът е бил добавен директно в WooCommerce (не чрез PLUDATA sync) или `wc_product_id` не съвпада — `PLUNB` оставаше `0`.

Допълнително: `plunb` беше string `'0'`, а PostgreSQL връща INTEGER. Сравнението `0 === '0'` е `false` в JavaScript, което пречеше на SKU fallback-а.

### Решение
Две промени:
1. **SKU fallback:** ако primary lookup по `wc_product_id` не намери резултат, търси по `detelina_nn` (SKU):
```javascript
// Primary lookup
const row = await pool.query(
  'SELECT detelina_nb FROM plu_mapping WHERE wc_product_id = $1 LIMIT 1',
  [wcProductId]
);
if (row.rows[0]) plunb = Number(row.rows[0].detelina_nb) || 0;

// SKU fallback
if (plunb === 0 && li.sku) {
  const row = await pool.query(
    'SELECT detelina_nb FROM plu_mapping WHERE detelina_nn = $1 LIMIT 1',
    [li.sku]
  );
  if (row.rows[0]) plunb = Number(row.rows[0].detelina_nb) || 0;
}
```

2. **Type fix:** `plunb` е число (не string) за коректно `=== 0` сравнение.

### Диагноза
```bash
# Провери дали продуктът е в plu_mapping
docker exec clvr_db_sync psql -U sync_user -d sync_bridge \
  -c "SELECT detelina_nb, detelina_nn, wc_product_id FROM plu_mapping WHERE detelina_nn = 'N5620';"

# Провери какъв SKU има продуктът в WooCommerce
docker exec clvr_db_sync psql -U sync_user -d sync_bridge \
  -c "SELECT detelina_nb, detelina_nn, wc_product_id FROM plu_mapping WHERE wc_product_id = 1931;"
```

---

## 12. Липсваща `escapeXml()` — невалиден XML при специални символи

### Симптом
Detelina не може да parse-не RDELIV файла. Грешка при import или файлът се игнорира без обяснение.

### Причина
Динамичните стойности в XML-а (`SEIK`, `CMNT`, `PLUNN`) се инжектираха директно без escaping. Ако съдържат `&`, `<`, `>`, `"` или `'` — XML-ът ставаше невалиден.

Примери:
- Фирма: `Иванов & Ко` → `<SEIK>Иванов & Ко</SEIK>` (невалиден XML)
- Коментар: `Клиент <важен>` → `<CMNT>Клиент <важен></CMNT>` (невалиден XML)

### Решение
Добави `escapeXml()` функция (като в работещия `app.js`) и я използвай за всички динамични стойности:
```javascript
function escapeXml(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// Използване в buildRdelivXml():
`<SEIK>${escapeXml(seik)}</SEIK>`
`<CMNT>${escapeXml(cmnt)}</CMNT>`
`<PLUNN>${escapeXml(li.sku || '')}</PLUNN>`
```

---

## 13. Polling цикълът не логва нищо — невъзможно е да се debug-не

### Симптом
`docker logs clvr_sync_engine` показва само startup реда. Няма индикация дали polling-ът работи, колко поръчки е намерил, или дали въобще се свързва с WooCommerce.

### Причина
`exportPendingOrders()` не логваше нито начало на цикъл, нито броя на намерените поръчки, нито "празен" резултат.

### Решение
Добави logging в poll цикъла:
```javascript
async function exportPendingOrders() {
  log('Polling WooCommerce for pending orders...');
  // ... fetch orders ...
  const orders = ordersRes.data || [];
  if (orders.length === 0) {
    log('No pending orders found.');
    return;
  }
  log(`Found ${orders.length} pending order(s) to export.`);
  // ... export loop ...
}
```

---

## 14. Sync engine продължава без DB — тих crash по-късно

### Симптом
Sync engine стартира, показва 10× `DB not ready` warnings, после хвърля неуловена грешка при `initDb()` и умира. Docker го рестартира и цикълът се повтаря.

### Причина
DB retry loop-ът нямаше `process.exit(1)` при 10-тия неуспех — кодът просто продължаваше напред.

### Решение
```javascript
for (let attempt = 1; attempt <= 10; attempt++) {
  try {
    await pool.query('SELECT 1');
    break;
  } catch (err) {
    log(`DB not ready (attempt ${attempt}/10): ${err.message}`, 'WARN');
    if (attempt === 10) {
      log('Could not connect to database after 10 attempts – exiting.', 'ERROR');
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}
```

---

## 15. `<TYP>1</TYP>` — заявката отива в грешен модул на Detelina

### Симптом
Заявката се импортира успешно, но не се вижда в очаквания модул. Или Detelina връща грешка за неправилен тип документ.

### Причина
- **TYP=1** = Заявка за доставка (incoming stock от доставчик) → модул "Заявки за доставка"
- **TYP=2** = Поръчка / Заявка за изписване (клиентска поръчка) → модул "Поръчки"

Онлайн поръчките от WooCommerce са клиентски поръчки за **изписване** — трябва **TYP=2**.

### Решение
В `buildRdelivXml()` в `sync-engine/index.js`:
```javascript
// ГРЕШНО — доставка (incoming stock):
`<TYP>1</TYP>`

// ПРАВИЛНО — клиентска поръчка (outgoing sales):
`<TYP>2</TYP>`
```

---

## 16. Два RDELIV файла за една поръчка (race condition)

### Симптом
В `transfer/` се появяват два файла за една и съща поръчка с различни timestamps:
```
EboIn_Order3248_20260307154153.xml
EboIn_Order3248_20260307154353.xml
```
Detelina обработва първия, вторият остава или предизвиква duplicate грешка.

### Причина
`exportOrder()` проверяваше за дубликат с `SELECT` преди `INSERT`. При едновременно изпълнение от webhook и poll loop — и двата виждат "не е изнесена" и генерират файл.

### Решение
Използвай `INSERT ... ON CONFLICT (wc_order_id) DO NOTHING RETURNING id`. Ако `RETURNING` не върне ред — друг процес вече е изнесъл поръчката:
```javascript
const ins = await pool.query(
  `INSERT INTO exported_orders (wc_order_id, xml_filename)
   VALUES ($1, $2)
   ON CONFLICT (wc_order_id) DO NOTHING
   RETURNING id`,
  [order.id, xmlName]
);
if (ins.rows.length === 0) {
  // Race condition — изтрий дублирания файл
  fs.unlinkSync(xmlPath);
  return;
}
```

---

## 17. `<SEIK>0</SEIK>` — контрагент не съществува в Detelina

### Симптом
Detelina лог показва:
```
[PluAddData]Plu not found in DB.
```
или файлът се преименува на `.err` с грешка "Contragent does not exist".

### Причина
Полето `<SEIK>` трябва да съдържа реален ЕИК на контрагент, **регистриран в Detelina**. Ако клиентът няма ЕИК и `DEFAULT_CUSTOMER_EIK` е `0` (стойността по подразбиране) — Detelina не може да намери контрагент с ЕИК `0` и отхвърля файла.

### Решение
Създай generic контрагент "Онлайн клиент" в Detelina с произволен ЕИК (напр. `1111111111`) и го постави в `.env` на сървъра:
```bash
# В ~/GitHub/Smart-clover-shop/wordpress/.env добави:
DEFAULT_CUSTOMER_EIK=1111111111
```

После рестартирай sync engine:
```bash
docker compose up -d --no-deps --force-recreate sync_engine
```

**Hierarchy на SEIK lookup** в `buildRdelivXml()`:
1. Мета поле `_billing_eik` на поръчката (custom checkout field)
2. Email lookup в таблица `customers` (от CUSTOMERS файл на Detelina)
3. `billing.company` поле
4. `DEFAULT_CUSTOMER_EIK` от `.env`

---

## 18. Продуктите не показват количество — само "In stock"

### Симптом
WooCommerce показва "In stock" на всички продукти без конкретно число, въпреки че настройката "Stock display format" е "Always show quantity remaining".

### Причина
Два отделни проблема:

**а) `_manage_stock = no` per продукт**
WooCommerce има две нива на stock management — глобално и per-продукт. `processPludata()` изпращаше само `stock_quantity` към WC API, но не и `manage_stock: true`. По подразбиране WC създава продукти с `manage_stock = no`, което означава "не следи количество" — игнорира `stock_quantity`.

**б) `_stock = NULL` в базата**
`_manage_stock` беше сменено на `yes` ръчно, но `_stock` стойността никога не беше записана — оставаше `NULL`, затова WC показваше "In stock" без число.

**в) `PQTTY` не се четеше при create/update**
`processPludata()` не включваше `pqtty` (количеството от Detelina XML) в `productData` обекта.

### Решение

**Код — `processPludata()` в `index.js`:**
```javascript
const pqtty = parseFloat(plu.PQTTY || '0');

const productData = {
  name:           plunm,
  regular_price:  price,
  status:         deleted ? 'trash' : 'publish',
  sku:            String(plu.PLUNN || plunb),
  manage_stock:   true,          // ← задължително!
  stock_quantity: Math.max(0, pqtty),  // ← от PQTTY в XML
  ...(categoryId ? { categories: [{ id: categoryId }] } : {}),
};
```

**Код — POSSALES stock update:**
```javascript
// Преди (пропускаше продукти без manage_stock):
const currentStock = prodRes.data.stock_quantity;
if (currentStock === null || currentStock === undefined) continue;
await wcApi('put', `products/${wcId}`, { stock_quantity: newStock });

// След:
const currentStock = prodRes.data.stock_quantity ?? 0;
await wcApi('put', `products/${wcId}`, { manage_stock: true, stock_quantity: newStock });
```

**Еднократен fix на съществуващи продукти в DB:**
```bash
docker exec clvr_db_wp mysql -u wp_user -pchange_me_wp wordpress \
  -e "UPDATE wp_postmeta SET meta_value='yes' WHERE meta_key='_manage_stock';"
```

**Изчисти WC transient кеша:**
```bash
docker exec clvr_db_wp mysql -u wp_user -pchange_me_wp wordpress \
  -e "DELETE FROM wp_options WHERE option_name LIKE '_transient_%' OR option_name LIKE '_site_transient_%';"
```

**Reprocess на PLU файл** (за да се запишат `_stock` стойностите):
```bash
# Изчисти историята на обработените PLU файлове
docker exec clvr_db_sync psql -U sync_user -d sync_bridge \
  -c "DELETE FROM processed_files WHERE filename LIKE '%PLU%';"

# Копирай архивирания файл обратно в transfer/ root
cp ~/GitHub/Smart-clover-shop/wordpress/transfer/archive/EboOut_PLU.xml \
   ~/GitHub/Smart-clover-shop/wordpress/transfer/EboOut_PLU_reprocess.xml
```

**Статус: ✅ Решен** — след reprocess на PLU файл продуктите показват конкретни количества.

---

## 19. Категориите показват "Uncategorized" — не се синхронизират от Detelina

### Симптом
Всички продукти са в категория "Uncategorized" въпреки че в PLU XML-а имат групи (GRP/GNM).

### Причина
В `processPludata()` полето за категория се четеше с **кирилска буква М** (`grp.GNМ` — Unicode U+041C) вместо латинска (`grp.GNM` — U+004D). XML парсерът връща ключовете точно такива, каквито са в XML файла. Тъй като XML-ът на Detelina ползва латинско `GNM`, кодът никога не намираше категорията.

```javascript
// ГРЕШНО — кирилска M:
const categoryName = grp && grp.GNМ ? grp.GNМ : null;

// ПРАВИЛНО — толерира и двете (латинска и кирилска M):
const categoryName = grp && (grp.GNM || grp.GNМ) ? (grp.GNM || grp.GNМ) : null;
```

### Диагноза
```bash
# Провери дали категориите са nil в DB:
docker exec clvr_db_wp mysql -u wp_user -pchange_me_wp wordpress \
  -e "SELECT p.post_title, t.name as category FROM wp_posts p
      LEFT JOIN wp_term_relationships tr ON p.ID=tr.object_id
      LEFT JOIN wp_term_taxonomy tt ON tr.term_taxonomy_id=tt.term_taxonomy_id AND tt.taxonomy='product_cat'
      LEFT JOIN wp_terms t ON tt.term_id=t.term_id
      WHERE p.post_type='product' AND p.post_status='publish' LIMIT 5;"
```

### Решение
Fix в `index.js` + reprocess на PLU файл (вижи проблем 18 за reprocess стъпките).

**Статус: ✅ Решен в код** — категориите ще се оправят при следващ PLUDATA файл от Detelina или при ръчен reprocess.

---

## Бързо ре-деплойване след `git pull`

```bash
cd ~/GitHub/Smart-clover-shop/wordpress
git pull

# Само sync_engine (без rebuild на image):
docker compose up -d --no-deps --force-recreate sync_engine

# Само FTP сървър:
docker compose up -d --no-deps --force-recreate ftp_server

# sync_engine с промени в Dockerfile/пакети:
docker compose up -d --no-deps --force-recreate --build sync_engine

# Всичко:
docker compose up -d
```

## Проверка на статуса

```bash
# Всички контейнери
docker compose ps

# Логове в реално време
docker compose logs -f sync_engine
docker compose logs -f ftp_server

# Тест на FTP rename локално
echo "test" > /tmp/t.tm~
curl -s --user "detelina:change_me_ftp" \
  -T /tmp/t.tm~ "ftp://127.0.0.1/t.tm~" \
  -Q "-RNFR t.tm~" -Q "-RNTO t.xml" 2>&1 | grep -E "250|550|530|421"

# Тест на WooCommerce API
curl -s "http://localhost:8082/wp-json/wc/v3/orders?consumer_key=${WP_KEY}&consumer_secret=${WP_SECRET}" \
  -H "X-Forwarded-Proto: https" | python3 -m json.tool | head -20
```
