import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * phone-app/ stays the single source of truth for the controller UI.
 * This task copies it into generated assets and injects the Android-only
 * bridge immediately before app.js. Nothing in the web source is forked.
 */
val phoneAppDir = rootProject.file("../phone-app")
val nativeBridgeFile = rootProject.layout.projectDirectory.file("web/native-bridge.js")
val generatedWebAssets = layout.buildDirectory.dir("generated/esp3dWebAssets")

val prepareWebAssets = tasks.register("prepareWebAssets") {
    group = "build"
    description = "Copies the ESP3D web controller into the APK and injects the native bridge."

    inputs.dir(phoneAppDir)
    inputs.file(nativeBridgeFile)
    outputs.dir(generatedWebAssets)

    doLast {
        val outputRoot = generatedWebAssets.get().asFile
        outputRoot.deleteRecursively()

        val www = outputRoot.resolve("www")
        phoneAppDir.copyRecursively(www, overwrite = true)

        val index = www.resolve("index.html")
        require(index.isFile) { "phone-app/index.html was not found at ${index.absolutePath}" }

        val appScript = "<script src=\"js/app.js"
        val html = index.readText()
        require(html.contains(appScript)) {
            "phone-app/index.html no longer contains the app.js script tag"
        }

        index.writeText(
            html.replace(
                appScript,
                "<script src=\"js/native-bridge.js\"></script>\n$appScript"
            )
        )

        nativeBridgeFile.asFile.copyTo(
            www.resolve("js/native-bridge.js"),
            overwrite = true
        )
    }
}

android {
    namespace = "com.esp3d.controller"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.esp3d.controller"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(generatedWebAssets.get().asFile)

    packaging {
        resources.excludes += setOf(
            "META-INF/AL2.0",
            "META-INF/LGPL2.1"
        )
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

/*
 * Some machines install only a JRE as the default Java runtime, which has no
 * javac. Ask Gradle for a real JDK so `./gradlew assembleDebug` works without
 * exporting JAVA_HOME. Bytecode still targets Java 17.
 */
java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

// Every task that consumes packaged assets must see the generated www/ tree first.
tasks.matching {
    (it.name.startsWith("merge") && it.name.endsWith("Assets")) ||
        it.name.lowercase().contains("lint")
}
    .configureEach { dependsOn(prepareWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
