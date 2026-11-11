# Matrix

**Matrix** is an in-development personal productivity and reminder application built with React Native and Expo. It focuses on on-device reminders, notes, and time-management tools, with Android as the primary development and testing platform.

> **Status:** Active development. Android builds are the primary target; iOS behavior and release readiness are not yet verified.

## Features in the current codebase

- Create reminders with one-time, daily, weekly, monthly, or yearly recurrence.
- Organize reminders with Today, All, Starred, and Completed views.
- Track completion and subtasks.
- Receive local reminder notifications with actions to complete, delete, dismiss, or snooze.
- Snooze for 5 minutes, 15 minutes, 1 hour, tomorrow, or a configured default interval.
- Create and manage locally stored notes.
- Configure preferences including notifications, default snooze interval, week start, completed-item visibility, and theme.
- Alarm, timer, and stopwatch UI functionality in the application code.

Notification timing, action availability, and alarm behavior depend on the device, Android permissions, operating-system restrictions, and build configuration. Not every feature is verified across platforms.

## Technology

- React Native 0.86 and React 19
- Expo SDK 57 and TypeScript
- Expo Notifications and Expo Updates
- AsyncStorage for on-device data
- React Native Safe Area Context and native date/time picker
- React Native Alarm Scheduler integration

## Development setup

Install Node.js and npm. This project uses native modules, so use a compatible native development build for testing functionality that Expo Go cannot support.

```bash
npm install
npm run start
```

To launch Android development:

```bash
npm run android
```

The repository also defines `npm run ios`, but iOS support has not been validated. Native builds require the relevant Android/iOS tooling or Expo Application Services (EAS).

## Android preview builds

The `eas.json` configuration includes `development`, `preview`, and `production` profiles. The preview profile is configured to produce an Android APK for internal distribution.

With the EAS CLI installed and the project configured under your own Expo account:

```bash
eas build --platform android --profile preview
```

Expo OTA updates are configured. An OTA update cannot replace a native rebuild when native dependencies or native configuration change.

## Local data and permissions

Reminders, notes, settings, and alarm records are stored on-device with AsyncStorage. This is not a cloud-synced account system. Removing application data or uninstalling the app may remove stored records.

Android notification permission, battery restrictions, and alarm scheduling capabilities can affect delivery. Test notification actions and recurring schedules on an actual device before relying on them for time-critical alerts.

## Project files

- `App.tsx` — main UI, reminder logic, notification actions, and local storage integration
- `app.json` — Expo app identity, native configuration, and update settings
- `eas.json` — development, preview, and production build profiles
- `index.ts` — Expo application entry point

## Roadmap

Continue refining notification reliability, usability, and cross-platform support. Future functionality should be considered planned until implemented and verified.
