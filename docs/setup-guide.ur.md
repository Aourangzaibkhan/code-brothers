# Code Brothers — Setup Guide (Roman Urdu)

Yeh guide aap ko Code Brothers platform apne computer par chalana sikhaye
gi. Sab kuch **bilkul free** hai — na koi paid AI, na koi server kharcha.
Poori tafseel ke liye English wali `setup-guide.md` dekhein.

## Zaroori cheezein

- Computer jisme kam az kam **4 GB free RAM** ho
- **Docker** (Windows/Mac par Docker Desktop, Linux par Docker Engine)
- **Git**

## Step 1 — Code download karein

```
git clone https://github.com/AourangZaibKhan/code-brothers.git
cd code-brothers
```

## Step 2 — `.env` file banayein

```
cp .env.example .env
```

`.env` file khol kar yeh values apni marzi ki mazboot values se badlein:

- `CB_MASTER_KEY` — 64 characters ki secret key. Banane ke liye command:
  `openssl rand -hex 32`
- `POSTGRES_PASSWORD` — database ka lamba password
- `REDIS_PASSWORD` — Redis ka lamba password

**Khayal rakhein:** `CB_MASTER_KEY` ko kisi mehfooz jagah (password
manager ya kagaz par) lazmi save karein. Platform ke tamam passwords isi
key se lock hote hain — agar yeh kho gayi to saved credentials wapas nahi
milenge.

## Step 3 — Platform start karein

Repository wale folder se yeh command chalain:

```
docker compose -f docker/docker-compose.lite.yml up -d
```

Thora intezar karein, phir browser mein **http://localhost:8080** kholein
— yeh aap ka dashboard hai. Yeh sirf aap ke apne computer par khulta hai,
internet par koi port open nahi hota.

## Step 4 — Owner account banayein (sirf pehli dafa)

Is platform ka **koi default password nahi** hai. Pehli dafa start hone
par API ek **one-time setup token** deti hai jo API ke log mein milta hai:

```
docker compose -f docker/docker-compose.lite.yml logs api
```

1. Dashboard kholein, setup token paste karein
2. Apna email aur ek mazboot naya password likhein
3. **Claim account** par click karein — is ke baad setup hamesha ke liye
   band ho jata hai, token dobara kaam nahi karega

Is ke foran baad **Security Center → Two-Factor Authentication** mein
ja kar **2FA lazmi on karein**.

## Step 5 — Apne accounts jorain (Credentials)

Dashboard mein **Credentials Vault** kholein aur jo service aap use karte
hain us ki details add karein — WhatsApp, Shopify, Daraz, YouTube,
Instagram. Yeh tamam credentials **free** milte hain; har ek ka tareeqa
`connectors.md` mein step-by-step likha hai. Credentials encrypted save
hote hain aur browser mein kabhi wapas nazar nahi aate.

## Step 6 — Pehla template chalain

1. **Workflows → Templates** mein ja kar koi ek template import karein,
   masalan `template-01-whatsapp-sales-assistant.json` (WhatsApp AI sales
   assistant)
2. Template ki **variables** bharein (apna phone number, product link
   waghera)
3. **Activate** kar dein — bas, automation chal pari

## Step 7 — Internet se webhooks ke liye (Cloudflare Tunnel)

WhatsApp aur stores ko aap ke system tak HTTPS par pohanchna hota hai.
**Cloudflare Tunnel** free hai aur is se **koi port open nahi karna
parta**:

1. `cloudflared` install karein (Cloudflare ki website se free)
2. `cloudflared tunnel login` aur `cloudflared tunnel create code-brothers`
3. Apna domain tunnel se jor kar tunnel run karein, aur webhook wali
   HTTPS address apne store/Meta settings mein paste kar dein

## Aakhri baat

Asli customers jorne se pehle **`hardening-guide.md`** wali security
checklist lazmi mukammal karein — 2FA test, backup test, aur kill switch
test khaas taur par. Koi masla aaye to English guide ke aakhir mein
Troubleshooting table mojood hai.
