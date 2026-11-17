# Peak Counter

Counts the **highest live viewers** of YouTube streams and the **highest participant count** of a Zoom
meeting during a set time, then sends the numbers by **SMS from your own Android phone**.
Everything runs on free services: Firebase (website, login, data), GitHub Actions (the counter) and
your phone (SMS + backup).

```
 Phone/PC browser ──► Web app (Firebase Hosting) ──► Firestore (automations, runs, peaks, SMS jobs)
                              │ Start                        ▲               │
                              ▼                              │               ▼
                    GitHub Actions "counter" job ────────────┘     Android app on the sender's phone
                    (YouTube API + Zoom web-client guest)          (sends SMS from its SIM; backup
                                                                     YouTube counting if GitHub is quiet)
```

## Folders

| Folder | What |
|---|---|
| `web/` | React web app (works on phone). Login, automations, Start/Stop, live peaks, history, settings. |
| `counter/` | Python counter run by `.github/workflows/counter.yml`. Up to ~5.5 h per job, then hands over to a new job. |
| `android/` | Phone app (Kotlin). Built by `.github/workflows/android.yml` and published as the `phone-app` release. |
| `firestore.rules` | Only approved emails can read or change anything. |

## How a run works

1. You press **Start** on an automation. The web app saves a run (with a copy of the settings) and starts the GitHub `counter` job.
2. The counter waits for the start time, then every N seconds reads each YouTube stream's live viewers and the Zoom participant count, keeping the highest values.
   * **Live event** streams count whenever they are live inside the run.
   * **24/7** streams count only inside their from–to window.
   * **Zoom**: the counter joins the meeting from a browser as a muted guest with the name you set, and subtracts itself.
3. At the end time (or when you press **Stop now**), it fills your SMS format and creates an SMS job.
4. The sender's phone app picks up the job and sends the SMS from its SIM. The run shows *sent* or *failed*, with a **Resend** button.
5. If the GitHub counter stops updating for 3 minutes, the sender's phone counts YouTube itself and sends the SMS at the end time.

SMS format fill-ins: `{name}`, `{date}`, and each source key, e.g. `{yt1}`, `{yt2}`, `{zoom}`. Missing values show `NA`.

## One-time setup

### Firebase (console.firebase.google.com, project `youtub-and-zoom-count`)
1. **Authentication** → Sign-in method → enable **Google** and **Email/Password**. Under Settings → Authorized domains, keep `youtub-and-zoom-count.web.app`.
2. **Firestore Database** → create (asia-south1, production mode).
3. **Firestore** → start collection `allowedUsers` → document id = your Gmail address in lower case → field `role` = `admin`. (Everyone else is added later from the web app.)
4. **Project settings → Your apps**: add a **Web app** and an **Android app** (package `com.peakcounter.app`). Note the web `appId`, Android `appId`, `apiKey` and `messagingSenderId`.
5. **Project settings → Service accounts** → *Generate new private key* (JSON file). Keep it private.

### GitHub (repository → Settings → Secrets and variables → Actions)
| Secret | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Whole JSON file from step 5 |
| `FIREBASE_API_KEY` | `apiKey` |
| `FIREBASE_WEB_APP_ID` | Web app `appId` |
| `FIREBASE_SENDER_ID` | `messagingSenderId` |
| `FIREBASE_ANDROID_APP_ID` | Android app `appId` |
| `YOUTUBE_API_KEY` | Google Cloud → APIs → enable *YouTube Data API v3* → Credentials → API key (optional: without it the counter reads the YouTube page) |
| `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` + `ANDROID_KEY_ALIAS` + `ANDROID_KEY_PASSWORD` | Optional: fixed signing key so phone-app updates install over the old version |

Then create a **fine-grained personal access token** (GitHub → Settings → Developer settings) for *only this repository* with **Actions: Read and write**, and paste it in the web app → Settings → *Counter settings*. The web app uses it only to start the counter job.

### Phones
1. Each person signs in to the website with Google once, then sets a **Phone app password** in Settings.
2. Install `PeakCounter.apk` from the repository's **Releases → phone-app** (allow installing from your browser).
3. Sign in with the same email and that password, name the phone, choose the Jio SIM, **Turn ON**, and **Allow background running**.
4. Send a test SMS. The phone now appears in the web app as a sender.

## Limits to know
* GitHub may start the counter 10–60 seconds after you press Start. Press Start a few minutes early; it waits for the start time.
* YouTube refreshes its viewer number about every 30 seconds, so a very short spike can be missed.
* Zoom's web page changes from time to time; if Zoom counting fails, the run log says why and screenshots are saved on the GitHub job.
* Firebase free plan: about 20,000 writes a day. Checking every 20 s uses ~180 writes per hour per automation.
