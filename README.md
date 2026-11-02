# Receiver

Een eenvoudige afstandsbediening voor de Denon AVR-X1200W thuis, als
Android-app. Gemaakt omdat de officiële *Denon AVR Remote* (2,0 sterren in de
Play Store) te veel schermen en te weinig overzicht heeft.

Twee tabbladen:

- **Bediening**: aan/uit, een draaiknop voor het volume met het display van de
  receiver erin, harder/zachter/dempen, de ingangen die je gebruikt, en
  **Favorieten**.
- **Geluid**: de geluidsstand (Automatisch, Stereo, Direct, Film, Muziek, Game).

De app zoekt de receiver zelf op de wifi. Lukt dat niet, dan vul je bij
Instellingen het IP-adres in.

---

## Wat de knoppen doen

| Knop | |
| --- | --- |
| **TV Audio, Online Music, …** | schakelt naar die ingang. Welke er staan kies je bij Instellingen → *Knoppen op het scherm*; Game, CBL/SAT, AUX en Bluetooth staan standaard uit. |
| **Internet Radio** | start de laatst gespeelde zender (de bovenste uit *Recently Played* op de receiver). Alleen de ingang kiezen zou de receiver op een leeg scherm zetten. |
| **Spotify** | opent de Spotify-app. Kies daar de receiver als luidspreker (Spotify Connect); de receiver schakelt dan zelf om. Vanuit deze app valt Spotify niet te starten. |
| **Favorieten** | de lijst met je zenders; tik er een aan en hij speelt. |
| **Draaiknop** | draai met je vinger om de ring. Een tik laat het volume nooit verspringen. Verder dan het maximum (standaard 70, bij Instellingen aan te passen) gaat hij niet. |

### Favorieten

De eerste keer haalt de app de favorieten van de receiver op (zo'n 15
seconden; de receiver staat dan even op Online Music). Daarna kun je ze bij
**Aanpassen**:

- **verschuiven** met de pijltjes,
- **verbergen** met het oog (en weer tonen),
- **aanpassen**: een andere naam, of een **eigen adres** voor de stream — handig
  als een zender een nieuw adres heeft gekregen en niet meer speelt,
- een zender **toevoegen** met naam en adres.

Een zender met een eigen adres speelt de receiver rechtstreeks af (als
"Media Server"). De receiver speelt alleen **http**-adressen, geen https; de
app zegt het als je een https-adres invult.

*Opnieuw ophalen van de receiver* werkt de lijst bij en laat je volgorde,
namen, adressen en verborgen zenders staan.

---

## Installeren

1. Open op je telefoon in Chrome de
   [laatste release](https://github.com/mkelderm/receiver/releases/latest).
2. Tik onder *Assets* op **receiver-x.y.z.apk**.
3. Android vraagt of Chrome apps mag installeren. Tik op **Instellingen**, zet
   *Toestaan van deze bron* aan en ga terug.
4. Tik op **Installeren**.

Bijwerken gaat net zo: download de nieuwe APK en installeer hem over de oude
heen. Je favorieten en instellingen blijven staan.

> Play Protect kan waarschuwen dat de app onbekend is. Dat klopt: hij komt niet
> uit de Play Store. Kies *Toch installeren*.

De telefoon moet op de wifi thuis zitten. **Op de receiver** moet
*Netwerkbeheer* (Network Control) aan staan, anders is hij in stand-by niet te
bereiken en kan de app hem niet aanzetten.

### Een nieuwe versie uitbrengen

Net als bij Suikerwater: commit en push naar `main`, en geef de versie een tag.

```bash
git tag v1.0.1
git push origin v1.0.1
```

De workflow *Android* draait eerst de tests en bouwt dan de ondertekende APK
als release. Zonder tag komt er bij elke push alleen een testbuild als
artefact bij de run; die heet *Receiver (test)* en komt naast de echte app te
staan. `v1.2.3` wordt versiecode 10203, dus minor en patch gaan tot en met 99.

### De ondertekensleutel

Android installeert een update alleen als die met **dezelfde sleutel** is
ondertekend. Die staat op de pc waar hij gemaakt is, in de map
`.receiver-signing` in je gebruikersmap (het sleutelbestand en het
wachtwoord), en als geheimen in de repository: `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`receiver`) en
`ANDROID_KEY_PASSWORD`. Het is een andere sleutel dan die van Suikerwater.

**Maak een reservekopie van die map.** Zonder de sleutel kun je geen updates
meer uitbrengen en moet je de app verwijderen en opnieuw installeren.

---

## Hoe het werkt

Gewone HTML, CSS en JavaScript in `web/`, in een Android-app die de pagina in
een WebView toont — net als Suikerwater.

| Map / bestand | |
| --- | --- |
| `web/denon.js` | het protocol: adressen bouwen, de XML van de receiver lezen, routes door het menu. Zonder browser, dus te testen in Node. |
| `web/app.js` | het scherm: status ophalen, tekenen, knoppen, favorieten |
| `android/…/ReceiverBridge.kt` | geeft de verzoeken van de pagina door aan de receiver |
| `tools/dev-server.mjs` | dezelfde doorgifte op de pc, om in de browser te testen |
| `tools/make-icons.mjs` | tekent het icoon |
| `test/denon.test.mjs` | de tests, met echte antwoorden van de receiver in `test/fixtures/` |

### Met de receiver praten

De X1200W heeft een webserver op poort 80:

- statuspagina's in XML (`goform/formMainZone_MainZoneXmlStatusLite.xml` en
  verwanten), elke anderhalve seconde opgevraagd;
- `goform/formiPhoneAppDirect.xml?<commando>` voert elk commando uit het
  telnetprotocol uit (`MV255` is volume 25,5, `SITV` is TV Audio, `MSSTEREO`
  is stereo);
- op poort 8080 is hij ook een DLNA-speler (UPnP AVTransport); zo speelt hij
  een stream van een eigen adres af.

Een pagina in de WebView mag de receiver niet zelf aanspreken (ander adres,
geen https, geen CORS). Daarom vraagt de pagina alles op haar eigen adres op,
onder `/denon/<ip>/…`, en geeft `ReceiverBridge.kt` het door — alleen naar
adressen op het thuisnetwerk en alleen naar deze pagina's.

### Favorieten op de receiver

Er is geen commando dat de favorieten als lijst geeft; ook de eigen webpagina
van de receiver leest het menu op de tv regel voor regel. De app doet dat ook,
met wat de receiver daarbij doet (gemeten, 1 november 2026):

- de lijst is **rond**: na de laatste zender komt de eerste;
- regel 8 van het menu (`[ 17/27 ]`) is de plek van de cursor, maar die loopt
  een stap **achter** en wordt na bladeren niet bijgewerkt. De app houdt de
  plek zelf bij en controleert pas als het scherm stilstaat;
- **bladeren** per pagina doet op de eerste pagina iets anders dan verderop,
  en daarna negeert de receiver een paar knoppen. De app gebruikt het niet en
  stapt alleen omhoog en omlaag, in reeksen met 300 ms ertussen;
- te snel achter elkaar valt er soms een stap weg, vooral waar de lijst rond
  gaat; na elke reeks meet de app en corrigeert hij;
- net na het openen van Internet Radio (dat van internet komt) negeert de
  receiver knoppen een paar seconden;
- de regel met de **zendernaam** onder *Now Playing* werkt de receiver niet
  altijd bij. Daarom toont de app de naam van de favoriet die je zelf koos.

---

## Testen

```bash
node test/denon.test.mjs
```

```bash
node tools/dev-server.mjs
```

De testserver draait op <http://localhost:8790> en geeft de verzoeken door aan
de echte receiver; de app vindt hem vanzelf.

## Zelf de APK bouwen

```bash
cd android
./gradlew assembleDebug
```
