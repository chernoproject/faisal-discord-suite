<div dir="rtl">

# Companion App — Windows 10 (تحكم بحساب User + تسجيل سكرين شير)

> ⚠️ **تحذير صريح:** يستخدم حساب ديسكورد عادي عبر متصفح آلي (Playwright). هذا **مخالف لـ ToS ديسكورد** والحساب راح يتحظر في النهاية. استخدم **حساب احتياطي مخصص**.

## وش يقدر يسوي؟

- ✅ تغيير اسم الحساب (Username + Display Name)
- ✅ تغيير الأفتار، البانر، الـ Bio
- ✅ تغيير حالة التواجد (Online/DND/Idle/Invisible)
- ✅ Custom Status (نص + إيموجي)
- ✅ دخول/خروج روم صوتي
- ✅ كتم / فك الكتم
- ✅ تشغيل/إيقاف الكاميرا
- ✅ بدء/إيقاف سكرين شير
- ✅ تسجيل سطح المكتب فعلياً (ffmpeg + gdigrab)

كل هذي الأوامر تستدعى من البوت عبر `/account`, `/voice`, `/share`, `/camera`.

## المتطلبات

- جهاز Windows 10/11 مسجّل دخول لحسابك (الـ companion يحتاج desktop session حقيقي).
- نفس متطلبات SETUP.md (Node 20, Git, FFmpeg, Build Tools).
- حساب ديسكورد ثاني (اعتبره حساب "للحرق").

> 💡 **80 قيقا تكفي:** تسجيل ساعة بـ 720p@15fps + صوت 128kbps يطلع ~600MB. تقدر تخزّن 100+ ساعة.

## 1) ثبّت Chromium للـ Playwright

```powershell
cd $HOME\faisal-discord-suite
npx playwright install chromium
```

## 2) (مهم) جهّز جهاز صوت قابل للتسجيل

ويندوز افتراضياً ما يخلّيك تسجل الصوت اللي يطلع من السماعات. عندك خيارين:

### أ — تفعيل "Stereo Mix" (أسرع، مجاني)
1. كليك يمين على أيقونة الصوت → Sounds → Recording tab.
2. كليك يمين على الفراغ → Show Disabled Devices.
3. لو ظهر "Stereo Mix" → كليك يمين → Enable → Set as Default Device.
4. لو ما ظهر، فاكتشف drivers الصوت ما تدعمه — استخدم الخيار ب.

### ب — VB-Audio Virtual Cable (يشتغل دايماً)
1. حمّل من https://vb-audio.com/Cable/
2. ثبّت كـ Administrator وأعد التشغيل.
3. كليك يمين على أيقونة الصوت → Open Sound Settings → App Volume and Device Preferences.
4. اختر التطبيق اللي تبي تسجل صوته (Chrome للـ companion) → Output: `CABLE Input`.
5. الأمر اللي يطلع منه الصوت لاحقاً يكون: `audio=CABLE Output (VB-Audio Virtual Cable)`.

### معرفة اسم الجهاز بالضبط
```powershell
ffmpeg -list_devices true -f dshow -i dummy 2>&1 | Select-String "DirectShow audio"
```
انسخ السطر اللي يبدأ بـ `"..."` (بين علامتي تنصيص) — هذا اسم الجهاز.

## 3) عبّ ملف البيئة

```powershell
cd $HOME\faisal-discord-suite
Copy-Item companion\.env.example companion\.env
notepad companion\.env
```

عبّ المطلوب:

| المتغير | القيمة |
|---|---|
| `DISCORD_USER_TOKEN` | راجع القسم 4 أدناه |
| `ACCOUNT_PASSWORD` | كلمة سر حساب الـ companion (لتغيير الـ Username) — اختياري |
| `TARGET_GUILD_ID` | معرّف سيرفرك |
| `TARGET_VOICE_CHANNEL_ID` | الروم الصوتي |
| `BOT_AUTH_TOKEN` | اختر نص عشوائي طويل (نفسه في `bot\.env`) |
| `WINDOWS_AUDIO_DEVICE` | اسم جهاز الصوت من القسم 2 (مع علامات التنصيص) |
| `FFMPEG_PATH` | فاضي لو ffmpeg في PATH، أو مسار `ffmpeg.exe` كامل |

## 4) استخراج توكن حساب user (بحذر)

⚠️ هذا التوكن يعطي **صلاحية كاملة على الحساب**. ما تنشره أبداً.

1. سجّل دخول للحساب الاحتياطي في https://discord.com.
2. اضغط F12 → روح لتبويب **Network**.
3. في فلتر Filter اكتب: `users/@me`.
4. اضغط أي صفحة في ديسكورد (مثلاً Friends).
5. اضغط على أي طلب لـ `/users/@me` → في Headers → ابحث عن `authorization`.
6. انسخ القيمة (بدون علامات تنصيص) → الصقها في `companion\.env` → `DISCORD_USER_TOKEN=`.

> **بدائل:** هناك سكربتات Console لاستخراج التوكن، لكن ديسكورد يحظر الإلصاق في Console منذ 2023. الطريقة أعلاه الأضمن.

## 5) أكمل `bot\.env` للاتصال بالـ companion

```powershell
notepad $HOME\faisal-discord-suite\bot\.env
```

عبّ:
```
COMPANION_WS_URL=ws://localhost:8788
COMPANION_AUTH_TOKEN=نفس-القيمة-في-companion-env
```

> مهم: قيم `BOT_WS_URL` و `BOT_AUTH_TOKEN` في `companion\.env` تخص تطبيق الـ companion فقط. البوت يقرأ من `bot\.env`؛ لذلك لازم تضع `COMPANION_WS_URL` و `COMPANION_AUTH_TOKEN` هناك. لو نسخت `BOT_WS_URL` و `BOT_AUTH_TOKEN` إلى `bot\.env` بالخطأ، البوت سيحاول استنتاج رابط الـ companion تلقائياً بتحويل `ws://localhost:8787` إلى `ws://localhost:8788`.

> لو الـ companion على جهاز ثاني، استبدل `localhost` بـ IP الجهاز وافتح المنفذ 8788 في Firewall.

## 6) شغّل الـ Companion

### تطوير
```powershell
npm run -w companion dev
```

### إنتاج
```powershell
npm run -w companion build
node companion\dist\index.js
```

أول تشغيل:
- يفتح Chromium بحجم 1280×720.
- يحقن التوكن في localStorage.
- يدخل تلقائياً على /channels/{guild}/{voice_channel}.
- لو `AUTO_JOIN_VOICE=true` يحاول دبل كليك على الروم (قد يحتاج تأكيد من المستخدم في أول مرة).

### للتشغيل الدائم
راجع [WINDOWS.md](./WINDOWS.md) قسم 4 لتركيبه كـ Windows Service.

## 7) جرّب من البوت

في ديسكورد، اكتب:
- `/account status` → يطلع `ok: true` ومعلومات `/me`.
- `/account presence value:dnd` → الحساب يصير "مشغول".
- `/voice join` → الحساب يدخل الروم.
- `/share start` → سكرين شير + تسجيل محلي.
- `/share stop` → ينقطع الشير، ملف MP4 يحفظ في `companion\out\`.

## نصائح لتقليل خطر الحظر

- **لا تستخدم الحساب لشي ثاني** — لا رسائل، لا تفاعلات، لا انضمام لسيرفرات أخرى.
- **توقف بين الجلسات** — لا تخلّيه شغّال 24/7. شغّله لما تبي التسجيل.
- **ثبات الـ IP** — لا تستخدم VPN متغيّر. ثبات IP يقلل علم الـ trust score.
- **اسم وأفتار ثابتين** — تغيير متكرر للاسم/الأفتار = علم أحمر لديسكورد.
- **توقع الحظر** — جهز حسابين احتياطيين. لو راحت روح، بدّل التوكن في `.env`.
- **لا تربط رقم جوالك** بحساب الـ companion — لو تحظر، الرقم يتحرق ومايصير تستخدمه لحساب جديد.

## حذف وإلغاء

```powershell
nssm remove FaisalCompanion confirm
Remove-Item -Recurse -Force $HOME\faisal-discord-suite\companion\companion-profile
Remove-Item -Recurse -Force $HOME\faisal-discord-suite\companion\out
```

</div>
