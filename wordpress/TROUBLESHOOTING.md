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
