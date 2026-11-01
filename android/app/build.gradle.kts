plugins {
    alias(libs.plugins.android.application)
}

// Versie en ondertekening komen van buiten, zodat dit bestand voor elke build
// hetzelfde blijft. De GitHub-workflow leidt de versie af van de git-tag
// (v1.2.3 -> versionName 1.2.3, versionCode 10203) en haalt de sleutel uit de
// geheimen van de repository; zie .github/workflows/android.yml.
val appVersionName: String = providers.gradleProperty("appVersionName").getOrElse("0.0.0-dev")
val appVersionCode: Int = providers.gradleProperty("appVersionCode").map(String::toInt).getOrElse(1)

val keystore = providers.environmentVariable("RECEIVER_KEYSTORE")

android {
    namespace = "io.github.mkelderm.receiver"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.mkelderm.receiver"
        // Android 8.0. Daarvoor bestonden adaptieve iconen nog niet.
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        // Testbuilds: een vaste sleutel die bewust in de repository staat, met
        // het standaardwachtwoord van Android voor debug-sleutels. Zonder die
        // maakt elke GitHub-runner een nieuwe, en gaat de ene testbuild niet
        // over de andere heen. Geheim hoeft hij niet te zijn: hij tekent alleen
        // "Receiver (test)", een andere app dan de echte.
        getByName("debug") {
            storeFile = file("test.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        // De echte sleutel komt uit de omgeving en staat nooit in de repository.
        // Zonder die sleutel wordt de release-APK niet ondertekend en weigert
        // Android hem te installeren.
        if (keystore.isPresent) {
            create("release") {
                storeFile = file(keystore.get())
                storePassword = providers.environmentVariable("RECEIVER_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("RECEIVER_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("RECEIVER_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        // Een testbuild krijgt een eigen pakketnaam en heet "Receiver (test)"
        // (src/debug/res). Hij komt dus naast de echte app te staan en kan die,
        // met een andere sleutel, nooit per ongeluk vervangen.
        debug {
            applicationIdSuffix = ".test"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// De webapp in ../web is de enige bron: de APK neemt die map ongewijzigd op als
// assets. Zo draait de app op de telefoon precies dezelfde code als de
// testversie in de browser, en hoeft er niets gekopieerd te worden.
androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addStaticSourceDirectory(
            rootProject.layout.projectDirectory.dir("../web").asFile.path
        )
    }
}

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.webkit)
}
