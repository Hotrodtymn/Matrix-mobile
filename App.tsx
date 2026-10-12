import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  useColorScheme,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Notifications from "expo-notifications";
const STORAGE_KEY = "matrix.reminders.v1";
const NOTES_KEY = "matrix.notes.v1";
const SETTINGS_KEY = "matrix.settings.v1";
const ALARMS_KEY = "matrix.alarms.v1";
const NOTIFICATION_CATEGORY = "MATRIX_REMINDER";
type Recurrence = "once" | "daily" | "weekly" | "monthly" | "yearly";
type AppView = "today" | "all" | "starred" | "completed";
type MatrixAlarm = { id: string; hour: number; minute: number; enabled: boolean; sound: "default" | "silent"; notificationId?: string };
type ClockTab = "alarm" | "timer" | "stopwatch";
type AppSettings = { notificationsEnabled: boolean; defaultSnoozeMinutes: number; weekStartsMonday: boolean; hideCompleted: boolean; theme: "default" | "dark" | "light" | "system" };
const DEFAULT_SETTINGS: AppSettings = { notificationsEnabled: true, defaultSnoozeMinutes: 15, weekStartsMonday: false, hideCompleted: true, theme: "default" };
type Subtask = {
  id: string;
  title: string;
  completed: boolean;
};
type Reminder = {
  id: string;
  title: string;
  date: string;
  notificationId: string;
  recurrence?: Recurrence;
  completed?: boolean;
  starred?: boolean;
  subtasks?: Subtask[];
};
type Note = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};
const NOTIFICATION_ACTIONS: Notifications.NotificationAction[] = [
  {
    identifier: "MARK_COMPLETED",
    buttonTitle: "Mark Completed",
    options: { opensAppToForeground: false },
  },
  {
    identifier: "DELETE",
    buttonTitle: "Delete",
    options: { isDestructive: true, opensAppToForeground: false },
  },
  {
    identifier: "SNOOZE_5",
    buttonTitle: "Snooze 5m",
    options: { opensAppToForeground: false },
  },
  {
    identifier: "SNOOZE_15",
    buttonTitle: "Snooze 15m",
    options: { opensAppToForeground: false },
  },
  { identifier: "SNOOZE_DEFAULT", buttonTitle: "Default Snooze", options: { opensAppToForeground: false } },
  {
    identifier: "SNOOZE_60",
    buttonTitle: "Snooze 1h",
    options: { opensAppToForeground: false },
  },
  {
    identifier: "SNOOZE_TOMORROW",
    buttonTitle: "Tomorrow",
    options: { opensAppToForeground: false },
  },
  {
    identifier: "DISMISS",
    buttonTitle: "Dismiss",
    options: {
      isDestructive: true,
      opensAppToForeground: false,
    },
  },
];
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});
// Prevent a notification response from being processed twice when Android
// reports it both as a launch response and as a listener event.
const handledNotificationResponses = new Set<string>();
async function cancelReminderNotifications(
  reminderId: string,
  fallbackNotificationId?: string,
  exceptNotificationId?: string,
) {
  if (fallbackNotificationId && fallbackNotificationId !== exceptNotificationId) {
    await Notifications.cancelScheduledNotificationAsync(
      fallbackNotificationId,
    ).catch(() => undefined);
  }
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(
    () => [],
  );
  await Promise.all(
    scheduled
      .filter(
        (item) =>
          item.identifier !== exceptNotificationId &&
          item.content.data?.reminderId === reminderId,
      )
      .map((item) =>
        Notifications.cancelScheduledNotificationAsync(item.identifier).catch(
          () => undefined,
        ),
      ),
  );
}
async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
) {
  const action = response.actionIdentifier;
  const request = response.notification.request;
  const requestId = request.identifier;
  const responseKey = `${requestId}:${action}`;
  if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  if (handledNotificationResponses.has(responseKey)) return;
  handledNotificationResponses.add(responseKey);
  // Keep this set bounded during a long-running app session.
  if (handledNotificationResponses.size > 100) {
    const oldest = handledNotificationResponses.values().next().value;
    if (oldest) handledNotificationResponses.delete(oldest);
  }
  const reminderId =
    typeof request.content.data?.reminderId === "string"
      ? request.content.data.reminderId
      : undefined;
  if (action === "MARK_COMPLETED" || action === "DELETE") {
    if (!reminderId) {
      await Notifications.dismissNotificationAsync(requestId).catch(
        () => undefined,
      );
      return;
    }
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    const reminders = stored ? (JSON.parse(stored) as Reminder[]) : [];
    const reminder = reminders.find((item) => item.id === reminderId);
    if (!reminder) {
      await Notifications.dismissNotificationAsync(requestId).catch(
        () => undefined,
      );
      return;
    }
    if (action === "DELETE") {
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(reminders.filter((item) => item.id !== reminderId)),
      );
      await cancelReminderNotifications(
        reminderId,
        reminder.notificationId,
      );
      await Notifications.dismissNotificationAsync(requestId).catch(
        () => undefined,
      );
      return;
    }
    if (getRecurrence(reminder) === "once") {
      const updated = reminders.map((item) =>
        item.id === reminderId ? { ...item, completed: true } : item,
      );
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      await cancelReminderNotifications(reminderId, reminder.notificationId);
    } else {
      const nextDate = getTaskDate(
        reminder,
        new Date(new Date(reminder.date).getTime() + 1000),
      );
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Matrix Reminder",
          body: reminder.title,
          sound: "default",
          categoryIdentifier: NOTIFICATION_CATEGORY,
          data: { reminderId: reminder.id, title: reminder.title },
        },
        trigger: buildTrigger(nextDate, getRecurrence(reminder)),
      });
      const updated = reminders.map((item) =>
        item.id === reminderId
          ? {
              ...item,
              date: nextDate.toISOString(),
              notificationId,
              completed: false,
            }
          : item,
      );
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      await cancelReminderNotifications(
        reminderId,
        reminder.notificationId,
        notificationId,
      );
    }
    await Notifications.dismissNotificationAsync(requestId).catch(
      () => undefined,
    );
    return;
  }
  if (action === "DISMISS") {
    await Notifications.dismissNotificationAsync(requestId).catch(
      () => undefined,
    );
    return;
  }
  const snoozeMinutes: Record<string, number> = {
    SNOOZE_5: 5,
    SNOOZE_15: 15,
    SNOOZE_60: 60,
    SNOOZE_TOMORROW: 1440,
  };
  const storedSettings = await AsyncStorage.getItem(SETTINGS_KEY);
  const preferences = storedSettings ? (JSON.parse(storedSettings) as Partial<AppSettings>) : {};
  const minutes = action === "SNOOZE_DEFAULT"
    ? (preferences.defaultSnoozeMinutes ?? DEFAULT_SETTINGS.defaultSnoozeMinutes)
    : snoozeMinutes[action];
  if (!minutes) return;
  const originalTitle =
    typeof request.content.data?.title === "string"
      ? request.content.data.title
      : request.content.body || request.content.title || "Reminder";
  const snoozeDate = new Date(Date.now() + minutes * 60 * 1000);
  const channel = Platform.OS === "android" ? { channelId: "reminders" } : {};
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Matrix Reminder · Snoozed",
      body: originalTitle,
      sound: "default",
      categoryIdentifier: NOTIFICATION_CATEGORY,
      data: {
        reminderId,
        title: originalTitle,
        isSnoozed: true,
      },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: snoozeDate,
      ...channel,
    },
  });
  await Notifications.dismissNotificationAsync(requestId).catch(
    () => undefined,
  );
}
function getRecurrence(reminder: Reminder): Recurrence {
  return reminder.recurrence ?? "once";
}
function getTaskDate(reminder: Reminder, from = new Date()): Date {
  if (getRecurrence(reminder) === "once") {
    return new Date(reminder.date);
  }
  const base = new Date(reminder.date);
  const result = new Date(base);
  result.setSeconds(0, 0);
  if (getRecurrence(reminder) === "daily") {
    result.setFullYear(from.getFullYear(), from.getMonth(), from.getDate());
    if (result.getTime() <= from.getTime()) {
      result.setDate(result.getDate() + 1);
    }
    return result;
  }
  if (getRecurrence(reminder) === "weekly") {
    result.setFullYear(from.getFullYear(), from.getMonth(), from.getDate());
    const daysAhead = (base.getDay() - result.getDay() + 7) % 7;
    result.setDate(result.getDate() + daysAhead);
    if (result.getTime() <= from.getTime()) {
      result.setDate(result.getDate() + 7);
    }
    return result;
  }
  if (getRecurrence(reminder) === "yearly") {
    result.setFullYear(from.getFullYear(), base.getMonth(), base.getDate());
    if (result.getTime() <= from.getTime()) result.setFullYear(result.getFullYear() + 1);
    return result;
  }
  const targetDay = base.getDate();
  result.setDate(1);
  result.setFullYear(from.getFullYear(), from.getMonth(), 1);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0,
  ).getDate();
  result.setDate(Math.min(targetDay, lastDay));
  if (result.getTime() <= from.getTime()) {
    result.setMonth(result.getMonth() + 1, 1);
    const nextLastDay = new Date(
      result.getFullYear(),
      result.getMonth() + 1,
      0,
    ).getDate();
    result.setDate(Math.min(targetDay, nextLastDay));
  }
  return result;
}
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function isToday(date: Date): boolean {
  return dateKey(date) === dateKey(new Date());
}
function reminderOccursOnDate(reminder: Reminder, targetDate: Date): boolean {
  const base = new Date(reminder.date);
  const target = new Date(targetDate);
  if (getRecurrence(reminder) === "once") return dateKey(base) === dateKey(target);
  if (getRecurrence(reminder) === "daily") return true;
  if (getRecurrence(reminder) === "weekly") return base.getDay() === target.getDay();
  if (getRecurrence(reminder) === "yearly") {
    return base.getMonth() === target.getMonth() && base.getDate() === target.getDate();
  }
  const lastDayOfTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return Math.min(base.getDate(), lastDayOfTargetMonth) === target.getDate();
}
function getReminderOccurrenceDate(reminder: Reminder, targetDate: Date): Date {
  const base = new Date(reminder.date);
  const result = new Date(targetDate);
  result.setHours(base.getHours(), base.getMinutes(), 0, 0);
  return result;
}
function formatDate(value: string | Date): string {
  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function formatTime(value: string | Date): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
function recurrenceLabel(recurrence?: Recurrence): string {
  switch (recurrence ?? "once") {
    case "daily":
      return "Repeats daily";
    case "weekly":
      return "Repeats weekly";
    case "monthly":
      return "Repeats monthly";
    case "yearly":
      return "Repeats yearly";
    default:
      return "One-time reminder";
  }
}
function buildTrigger(date: Date, recurrence: Recurrence) {
  const channel = Platform.OS === "android" ? { channelId: "reminders" } : {};
  if (recurrence === "daily") {
    return {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: date.getHours(),
      minute: date.getMinutes(),
      ...channel,
    } satisfies Notifications.NotificationTriggerInput;
  }
  if (recurrence === "weekly") {
    return {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday: date.getDay() + 1,
      hour: date.getHours(),
      minute: date.getMinutes(),
      ...channel,
    } satisfies Notifications.NotificationTriggerInput;
  }
  if (recurrence === "monthly") {
    return {
      type: Notifications.SchedulableTriggerInputTypes.MONTHLY,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      ...channel,
    } satisfies Notifications.NotificationTriggerInput;
  }
  if (recurrence === "yearly") {
    return {
      type: Notifications.SchedulableTriggerInputTypes.YEARLY,
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      ...channel,
    } satisfies Notifications.NotificationTriggerInput;
  }
  return {
    type: Notifications.SchedulableTriggerInputTypes.DATE,
    date,
    ...channel,
  } satisfies Notifications.NotificationTriggerInput;
}
function getDefaultReminderDate() {
  const date = new Date();
  date.setSeconds(0, 0);
  const nextFiveMinuteMark = Math.ceil((date.getMinutes() + 1) / 5) * 5;
  date.setMinutes(Math.min(nextFiveMinuteMark, 59));
  if (date.getTime() <= Date.now()) date.setMinutes(date.getMinutes() + 1);
  return date;
}
export default function App() {
  const [title, setTitle] = useState("");
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [reminderDate, setReminderDate] = useState(
    getDefaultReminderDate(),
  );
  const [recurrence, setRecurrence] = useState<Recurrence>("once");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [view, setView] = useState<AppView>("today");
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showCalendarReminderModal, setShowCalendarReminderModal] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [expandedTasks, setExpandedTasks] = useState<string[]>([]);
  const [subtaskInputs, setSubtaskInputs] = useState<Record<string, string>>(
    {},
  );
  // Notes have their own storage key and do not change reminder data.
  const [showHome, setShowHome] = useState(true);
  const [showNotes, setShowNotes] = useState(false);
  const [showTaskList, setShowTaskList] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showClock, setShowClock] = useState(false);
  const [clockTab, setClockTab] = useState<ClockTab>("alarm");
  const [alarms, setAlarms] = useState<MatrixAlarm[]>([]);
  const [alarmTime, setAlarmTime] = useState(() => { const d = new Date(); d.setSeconds(0, 0); d.setMinutes(0); return d; });
  const [showAlarmTimePicker, setShowAlarmTimePicker] = useState(false);
  const [showAlarmModal, setShowAlarmModal] = useState(false);
  const [alarmSound, setAlarmSound] = useState<"default" | "silent">("default");
  const [timerHours, setTimerHours] = useState("0");
  const [timerMinutes, setTimerMinutes] = useState("5");
  const [timerSeconds, setTimerSeconds] = useState("0");
  const [timerEndAt, setTimerEndAt] = useState<number | null>(null);
  const [timerRemaining, setTimerRemaining] = useState(0);
  const [timerCompleted, setTimerCompleted] = useState(false);
  const [timerNotificationId, setTimerNotificationId] = useState<string | null>(null);
  const [stopwatchRunning, setStopwatchRunning] = useState(false);
  const [stopwatchStartedAt, setStopwatchStartedAt] = useState<number | null>(null);
  const [stopwatchElapsed, setStopwatchElapsed] = useState(0);
  const [expandedNotes, setExpandedNotes] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const systemColorScheme = useColorScheme();
  const isLightTheme = settings.theme === "light" || (settings.theme === "system" && systemColorScheme === "light");
  const themeStyles = useMemo(() => isLightTheme ? ({
    ...styles,
    safeArea: { ...styles.safeArea, backgroundColor: "#F3F6F5" },
    header: { ...styles.header, backgroundColor: "#FFFFFF", borderBottomColor: "#D9E2E0" },
    homeDateBlock: { ...styles.homeDateBlock, borderBottomColor: "#D9E2E0" },
    homeDate: { ...styles.homeDate, color: "#61716D" },
    homeTextButton: { ...styles.homeTextButton, backgroundColor: "#E5F2EF", borderColor: "#B6D9D1" },
    homeAlarmRow: { ...styles.homeAlarmRow, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    homeAlarmIcon: { ...styles.homeAlarmIcon, backgroundColor: "#E5F2EF", borderColor: "#B6D9D1" },
    homeAlarmTime: { ...styles.homeAlarmTime, color: "#182321" },
    appName: { ...styles.appName, color: "#182321" },
    heading: { ...styles.heading, color: "#182321" },
    description: { ...styles.description, color: "#536561" },
    list: { ...styles.list, backgroundColor: "#F3F6F5" },
    content: { ...styles.content, backgroundColor: "#F3F6F5" },
    settingsPlaceholder: { ...styles.settingsPlaceholder, backgroundColor: "#F3F6F5" },
    settingsCard: { ...styles.settingsCard, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    settingsTitle: { ...styles.settingsTitle, color: "#182321" },
    settingsHelp: { ...styles.settingsHelp, color: "#61716D" },
    sectionTitle: { ...styles.sectionTitle, color: "#526560" },
    sideMenu: { ...styles.sideMenu, backgroundColor: "#FFFFFF", borderRightColor: "#D9E2E0" },
    menuHeader: { ...styles.menuHeader, borderBottomColor: "#D9E2E0" },
    menuSubtitle: { ...styles.menuSubtitle, color: "#61716D" },
    menuSectionLabel: { ...styles.menuSectionLabel, color: "#61716D" },
    menuItem: { ...styles.menuItem, backgroundColor: "#F5F8F7" },
    menuItemText: { ...styles.menuItemText, color: "#253632" },
    menuDivider: { ...styles.menuDivider, backgroundColor: "#D9E2E0" },
    menuFooterText: { ...styles.menuFooterText, color: "#526560" },
    menuFooterSubtext: { ...styles.menuFooterSubtext, color: "#61716D" },
    taskCard: { ...styles.taskCard, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    taskTitle: { ...styles.taskTitle, color: "#182321" },
    taskDate: { ...styles.taskDate, color: "#526560" },
    subtaskArea: { ...styles.subtaskArea, borderTopColor: "#D9E2E0" },
    subtaskTitle: { ...styles.subtaskTitle, color: "#253632" },
    subtaskInput: { ...styles.subtaskInput, backgroundColor: "#F8FAF9", borderColor: "#D9E2E0", color: "#182321" },
    noteCard: { ...styles.noteCard, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    noteTitle: { ...styles.noteTitle, color: "#182321" },
    noteBody: { ...styles.noteBody, color: "#344641" },
    noteDate: { ...styles.noteDate, color: "#61716D" },
    noteActions: { ...styles.noteActions, borderTopColor: "#D9E2E0" },
    noteSearch: { ...styles.noteSearch, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0", color: "#182321" },
    input: { ...styles.input, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0", color: "#182321" },
    multilineInput: { ...styles.multilineInput, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0", color: "#182321" },
    noteBodyInput: { ...styles.noteBodyInput, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0", color: "#182321" },
    label: { ...styles.label, color: "#526560" },
    form: { ...styles.form, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    formTitle: { ...styles.formTitle, color: "#182321" },
    dateButton: { ...styles.dateButton, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    dateCaption: { ...styles.dateCaption, color: "#61716D" },
    dateValue: { ...styles.dateValue, color: "#182321" },
    recurrenceButton: { ...styles.recurrenceButton, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    recurrenceText: { ...styles.recurrenceText, color: "#526560" },
    repeatHint: { ...styles.repeatHint, color: "#61716D" },
    settingChoice: { ...styles.settingChoice, backgroundColor: "#F8FAF9", borderColor: "#D9E2E0" },
    settingChoiceText: { ...styles.settingChoiceText, color: "#526560" },
    clockTabs: { ...styles.clockTabs, backgroundColor: "#E8EFED", borderColor: "#D9E2E0" },
    clockTabActive: { ...styles.clockTabActive, backgroundColor: "#D6EAE6", borderColor: "#167E73" },
    clockTabText: { ...styles.clockTabText, color: "#526560" },
    clockTabTextActive: { ...styles.clockTabTextActive, color: "#167E73" },
    clockCard: { ...styles.clockCard, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    clockTimePickerButton: { ...styles.clockTimePickerButton, backgroundColor: "#F8FAF9", borderColor: "#D9E2E0" },
    clockBigTime: { ...styles.clockBigTime, color: "#182321" },
    alarmRow: { ...styles.alarmRow, backgroundColor: "#F3F6F5", borderColor: "#D9E2E0" },
    alarmTime: { ...styles.alarmTime, color: "#182321" },
    clockTimerDisplay: { ...styles.clockTimerDisplay, color: "#182321" },
    timerInput: { ...styles.timerInput, backgroundColor: "#F8FAF9", borderColor: "#D9E2E0", color: "#182321" },
    clockSecondaryButton: { ...styles.clockSecondaryButton, backgroundColor: "#F3F6F5", borderColor: "#D9E2E0" },
    clockSecondaryText: { ...styles.clockSecondaryText, color: "#526560" },
    calendarMonthTitle: { ...styles.calendarMonthTitle, color: "#182321" },
    calendarArrow: { ...styles.calendarArrow, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    calendarGrid: { ...styles.calendarGrid, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    calendarWeekday: { ...styles.calendarWeekday, color: "#61716D" },
    calendarDayText: { ...styles.calendarDayText, color: "#253632" },
    calendarReminder: { ...styles.calendarReminder, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    calendarReminderTitle: { ...styles.calendarReminderTitle, color: "#182321" },
    modalOverlay: { ...styles.modalOverlay, backgroundColor: "rgba(18, 30, 27, 0.42)" },
    scheduleModal: { ...styles.scheduleModal, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    modalTitle: { ...styles.modalTitle, color: "#182321" },
    modalSubtitle: { ...styles.modalSubtitle, color: "#61716D" },
    modalSecondaryButton: { ...styles.modalSecondaryButton, backgroundColor: "#F5F8F7", borderColor: "#D9E2E0" },
    modalSecondaryText: { ...styles.modalSecondaryText, color: "#526560" },
    emptyCard: { ...styles.emptyCard, backgroundColor: "#FFFFFF", borderColor: "#D9E2E0" },
    emptyTitle: { ...styles.emptyTitle, color: "#182321" },
    emptyText: { ...styles.emptyText, color: "#61716D" },
    footer: { ...styles.footer, borderTopColor: "#D9E2E0" },
  }) : styles, [isLightTheme]);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [noteSearch, setNoteSearch] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const notificationListener = useRef<Notifications.Subscription | null>(null);
  const responseListener = useRef<Notifications.Subscription | null>(null);
  useEffect(() => {
    async function initialize() {
      try {
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("reminders", {
            name: "Matrix Reminders",
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 250, 250, 250],
            sound: "default",
          });
        }
        await Notifications.setNotificationCategoryAsync(
          NOTIFICATION_CATEGORY,
          NOTIFICATION_ACTIONS,
        );
        const [storedReminders, storedNotes, storedSettings, storedAlarms] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          AsyncStorage.getItem(NOTES_KEY),
          AsyncStorage.getItem(SETTINGS_KEY),
          AsyncStorage.getItem(ALARMS_KEY),
        ]);
        if (storedSettings) setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(storedSettings) as Partial<AppSettings>) });
        if (storedAlarms) setAlarms(JSON.parse(storedAlarms) as MatrixAlarm[]);
        if (storedReminders) {
          const parsed = JSON.parse(storedReminders) as Reminder[];
          setReminders(
            parsed.map((reminder) => ({
              ...reminder,
              completed: reminder.completed ?? false,
              starred: reminder.starred ?? false,
              subtasks: reminder.subtasks ?? [],
            })),
          );
        }
        if (storedNotes) {
          const parsedNotes = JSON.parse(storedNotes) as Note[];
          setNotes(Array.isArray(parsedNotes) ? parsedNotes : []);
        }
      } catch (error) {
        console.error("Could not load Matrix:", error);
        Alert.alert(
          "Loading problem",
          "Matrix could not load some of your saved data.",
        );
      } finally {
        setLoading(false);
      }
    }
    void initialize();
    responseListener.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        void handleNotificationResponse(response)
          .then(async () => {
            const stored = await AsyncStorage.getItem(STORAGE_KEY);
            if (stored) setReminders(JSON.parse(stored) as Reminder[]);
            setNow(Date.now());
          })
          .catch((error) => {
            console.error("Could not process notification action:", error);
          });
      });
    void Notifications.getLastNotificationResponseAsync()
      .then(async (response) => {
        if (response) {
          await handleNotificationResponse(response);
          const stored = await AsyncStorage.getItem(STORAGE_KEY);
          if (stored) setReminders(JSON.parse(stored) as Reminder[]);
          setNow(Date.now());
        }
      })
      .catch((error) => {
        console.error("Could not process launch notification:", error);
      });
    notificationListener.current =
      Notifications.addNotificationReceivedListener(() => {
        setNow(Date.now());
      });
    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, []);
  useEffect(() => {
    const clockInterval = setInterval(() => {
      const current = Date.now();
      if (timerEndAt !== null) {
        const left = Math.max(0, Math.ceil((timerEndAt - current) / 1000));
        setTimerRemaining(left);
        if (left === 0) { setTimerEndAt(null); setTimerCompleted(true); }
      }
      if (stopwatchRunning && stopwatchStartedAt !== null) setStopwatchElapsed(current - stopwatchStartedAt);
    }, 30);
    return () => clearInterval(clockInterval);
  }, [timerEndAt, stopwatchRunning, stopwatchStartedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  async function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(updated)); }
    catch (error) { console.error("Could not save Matrix settings:", error); Alert.alert("Could not save setting", "Please try again."); }
  }
  function startReminderFromCalendar() {
    const selected = new Date(selectedCalendarDate);
    const defaultTime = getDefaultReminderDate();
    selected.setHours(defaultTime.getHours(), defaultTime.getMinutes(), 0, 0);
    if (selected.getTime() <= Date.now()) {
      const fallback = getDefaultReminderDate();
      selected.setHours(fallback.getHours(), fallback.getMinutes(), 0, 0);
      if (selected.getTime() <= Date.now()) selected.setDate(selected.getDate() + 1);
    }
    setReminderDate(selected);
    setTitle("");
    setSubtaskDraft("");
    setRecurrence("once");
    setShowCalendarReminderModal(true);
  }
  async function saveAlarms(updated: MatrixAlarm[]) {
    setAlarms(updated);
    await AsyncStorage.setItem(ALARMS_KEY, JSON.stringify(updated));
  }
  async function scheduleAlarmNotification(alarm: MatrixAlarm): Promise<string> {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      const requested = await Notifications.requestPermissionsAsync();
      if (!requested.granted) throw new Error("Notification permission is required for alarms.");
    }
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: { title: "Matrix Alarm", body: "Your alarm is ringing.", sound: alarm.sound === "silent" ? false : "default", data: { kind: "matrix-alarm", alarmId: alarm.id } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: alarm.hour, minute: alarm.minute, channelId: "reminders" },
    });
    return notificationId;
  }
  async function addAlarm() {
    try {
      const draft: MatrixAlarm = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, hour: alarmTime.getHours(), minute: alarmTime.getMinutes(), enabled: true, sound: alarmSound };
      const notificationId = await scheduleAlarmNotification(draft);
      await saveAlarms([{ ...draft, notificationId }, ...alarms]);
      setShowAlarmTimePicker(false);
      setShowAlarmModal(false);
      Alert.alert("Alarm added", `Daily alarm set for ${formatTime(new Date(2000, 0, 1, draft.hour, draft.minute))}.`);
    } catch (error) {
      Alert.alert("Could not set alarm", error instanceof Error ? error.message : "Please check notification permissions and try again.");
    }
  }
  async function toggleAlarm(alarm: MatrixAlarm) {
    try {
      if (alarm.enabled) {
        if (alarm.notificationId) await Notifications.cancelScheduledNotificationAsync(alarm.notificationId).catch(() => undefined);
        await saveAlarms(alarms.map((item) => item.id === alarm.id ? { ...item, enabled: false, notificationId: undefined } : item));
      } else {
        const notificationId = await scheduleAlarmNotification(alarm);
        await saveAlarms(alarms.map((item) => item.id === alarm.id ? { ...item, enabled: true, notificationId } : item));
      }
    } catch (error) {
      Alert.alert("Could not update alarm", error instanceof Error ? error.message : "Please try again.");
    }
  }
  async function deleteAlarm(alarm: MatrixAlarm) {
    if (alarm.notificationId) await Notifications.cancelScheduledNotificationAsync(alarm.notificationId).catch(() => undefined);
    await saveAlarms(alarms.filter((item) => item.id !== alarm.id));
  }
  async function startTimer() {
    const duration = Math.max(0, Number(timerHours) * 3600 + Number(timerMinutes) * 60 + Number(timerSeconds));
    if (!Number.isFinite(duration) || duration <= 0) { Alert.alert("Set a timer", "Enter a duration greater than zero."); return; }
    const endAt = Date.now() + duration * 1000;
    setTimerEndAt(endAt);
    setTimerRemaining(duration);
    setTimerCompleted(false);
    try {
      const id = await Notifications.scheduleNotificationAsync({ content: { title: "Matrix Timer", body: "Your timer has finished.", sound: "default" }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(endAt), channelId: "reminders" } });
      setTimerNotificationId(id);
    } catch (error) { console.warn("Timer notification could not be scheduled:", error); }
  }
  async function stopTimer() {
    if (timerNotificationId) await Notifications.cancelScheduledNotificationAsync(timerNotificationId).catch(() => undefined);
    setTimerNotificationId(null); setTimerEndAt(null); setTimerRemaining(0); setTimerCompleted(false);
  }
  function formatDuration(totalSeconds: number) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  function formatStopwatch(milliseconds: number) {
    const safe = Math.max(0, Math.floor(milliseconds));
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor((safe % 3600000) / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const millis = safe % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }
  async function saveReminders(updated: Reminder[]) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setReminders(updated);
  }  async function saveNotes(updated: Note[]) {
    await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(updated));
    setNotes(updated);
  }
  async function addReminder(): Promise<boolean> {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      Alert.alert("Add a reminder", "Enter what you need to be reminded about.");
      return false;
    }
    if (reminderDate.getTime() <= Date.now()) {
      Alert.alert(
        "Choose a future time",
        "Your reminder must be scheduled in the future.",
      );
      return false;
    }
    setSaving(true);
    let notificationId: string | undefined;
    try {
      let granted = settings.notificationsEnabled;
      if (settings.notificationsEnabled) {
      const permission = await Notifications.getPermissionsAsync();
      granted = permission.granted;
      if (!granted) {
        granted = (await Notifications.requestPermissionsAsync()).granted;
      }
      if (!granted) {
        Alert.alert(
          "Notifications are disabled",
          "Allow Matrix to send notifications in Android settings, or enable notifications in Matrix Settings.",
        );
        return false;
      }
      }
      const taskId = `${Date.now()}-${Math.random()}`;
      notificationId = settings.notificationsEnabled ? await Notifications.scheduleNotificationAsync({
        content: {
          title: "Matrix Reminder",
          body: cleanTitle,
          sound: "default",
          categoryIdentifier: NOTIFICATION_CATEGORY,
          data: { reminderId: taskId, title: cleanTitle },
        },
        trigger: buildTrigger(reminderDate, recurrence),
      }) : "";
      const subtasks: Subtask[] = subtaskDraft
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item, index) => ({
          id: `${taskId}-sub-${index}`,
          title: item,
          completed: false,
        }));
      const newReminder: Reminder = {
        id: taskId,
        title: cleanTitle,
        date: reminderDate.toISOString(),
        notificationId,
        recurrence,
        completed: false,
        starred: false,
          subtasks,
      };
      await saveReminders([newReminder, ...reminders]);
      setTitle("");
      setSubtaskDraft("");
      setRecurrence("once");
      setReminderDate(getDefaultReminderDate());
      setNow(Date.now());
      setShowCalendarReminderModal(false);
      Alert.alert("Reminder created", "Your reminder has been saved.");
      return true;
    } catch (error) {
      console.error("Could not create task:", error);
      if (notificationId) {
        await Notifications.cancelScheduledNotificationAsync(
          notificationId,
        ).catch(() => undefined);
      }
      Alert.alert("Couldn't save reminder", "Please try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function deleteReminder(reminder: Reminder) {
    Alert.alert("Delete reminder?", `Permanently remove reminder "${reminder.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await Notifications.cancelScheduledNotificationAsync(
                reminder.notificationId,
              ).catch(() => undefined);
              await saveReminders(
                reminders.filter((item) => item.id !== reminder.id),
              );
            } catch (error) {
              console.error("Could not delete task:", error);
              Alert.alert("Couldn't delete reminder", "Please try again.");
            }
          })();
        },
      },
    ]);
  }
  async function toggleStar(reminder: Reminder) {
    const updated = reminders.map((item) =>
      item.id === reminder.id ? { ...item, starred: !item.starred } : item,
    );
    try {
      await saveReminders(updated);
    } catch (error) {
      console.error("Could not update priority:", error);
      Alert.alert("Couldn't update reminder", "Please try again.");
    }
  }
  async function completeReminder(reminder: Reminder) {
    try {
      if (getRecurrence(reminder) === "once") {
        const updated = reminders.map((item) =>
          item.id === reminder.id ? { ...item, completed: true } : item,
        );
        await saveReminders(updated);
        await Notifications.cancelScheduledNotificationAsync(
          reminder.notificationId,
        ).catch(() => undefined);
        return;
      }
      const nextDate = getTaskDate(
        reminder,
        new Date(new Date(reminder.date).getTime() + 1000),
      );
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Matrix Reminder",
          body: reminder.title,
          sound: "default",
          categoryIdentifier: NOTIFICATION_CATEGORY,
          data: { reminderId: reminder.id, title: reminder.title },
        },
        trigger: buildTrigger(nextDate, getRecurrence(reminder)),
      });
      const updated = reminders.map((item) =>
        item.id === reminder.id
          ? {
              ...item,
              date: nextDate.toISOString(),
              notificationId,
              completed: false,
            }
          : item,
      );
      await saveReminders(updated);
      await Notifications.cancelScheduledNotificationAsync(
        reminder.notificationId,
      ).catch(() => undefined);
    } catch (error) {
      console.error("Could not complete task:", error);
      Alert.alert(
        "Couldn't complete reminder",
        "Matrix couldn't save this change. Please try again.",
      );
    }
  }
  async function restoreReminder(reminder: Reminder) {
    try {
      if (getRecurrence(reminder) === "once") {
        const nextDate = new Date(reminder.date);
        let notificationId = reminder.notificationId;
        if (settings.notificationsEnabled && nextDate.getTime() > Date.now()) {
          notificationId = await Notifications.scheduleNotificationAsync({
            content: {
              title: "Matrix Reminder",
              body: reminder.title,
              sound: "default",
              categoryIdentifier: NOTIFICATION_CATEGORY,
              data: { reminderId: reminder.id, title: reminder.title },
            },
            trigger: buildTrigger(nextDate, "once"),
          });
        } else {
          Alert.alert(
            "Reminder restored",
            "This reminder is overdue. Reschedule it to receive another notification.",
          );
        }
        await saveReminders(
          reminders.map((item) =>
            item.id === reminder.id
              ? { ...item, completed: false, notificationId }
              : item,
          ),
        );
      } else {
        await saveReminders(
          reminders.map((item) =>
            item.id === reminder.id ? { ...item, completed: false } : item,
          ),
        );
      }
    } catch (error) {
      console.error("Could not restore task:", error);
      Alert.alert("Couldn't restore reminder", "Please try again.");
    }
  }
  async function toggleSubtask(reminder: Reminder, subtask: Subtask) {
    const updated = reminders.map((item) =>
      item.id === reminder.id
        ? {
            ...item,
            subtasks: (item.subtasks ?? []).map((child) =>
              child.id === subtask.id
                ? { ...child, completed: !child.completed }
                : child,
            ),
          }
        : item,
    );
    try {
      await saveReminders(updated);
    } catch (error) {
      console.error("Could not update subtask:", error);
      Alert.alert("Couldn't update checklist", "Please try again.");
    }
  }
  async function addSubtask(reminder: Reminder) {
    const cleanText = (subtaskInputs[reminder.id] ?? "").trim();
    if (!cleanText) return;
    const child: Subtask = {
      id: `${Date.now()}-${Math.random()}`,
      title: cleanText,
      completed: false,
    };
    try {
      await saveReminders(
        reminders.map((item) =>
          item.id === reminder.id
            ? { ...item, subtasks: [...(item.subtasks ?? []), child] }
            : item,
        ),
      );
      setSubtaskInputs((current) => ({
        ...current,
        [reminder.id]: "",
      }));
    } catch (error) {
      console.error("Could not add subtask:", error);
      Alert.alert("Couldn't add step", "Please try again.");
    }
  }  function clearNoteEditor() {
    setEditingNoteId(null);
    setNoteTitle("");
    setNoteBody("");
  }
  async function saveNote() {
    const cleanTitle = noteTitle.trim();
    const cleanBody = noteBody.trim();
    if (!cleanTitle && !cleanBody) {
      Alert.alert("Empty note", "Enter a title or some note text first.");
      return;
    }
    setSavingNote(true);
    try {
      const nowIso = new Date().toISOString();
      let updated: Note[];
      if (editingNoteId) {
        updated = notes.map((note) =>
          note.id === editingNoteId
            ? {
                ...note,
                title: cleanTitle || "Untitled note",
                body: cleanBody,
                updatedAt: nowIso,
              }
            : note,
        );
      } else {
        const newNote: Note = {
          id: `note-${Date.now()}-${Math.random()}`,
          title: cleanTitle || "Untitled note",
          body: cleanBody,
          pinned: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        updated = [newNote, ...notes];
      }
      await saveNotes(updated);
      clearNoteEditor();
    } catch (error) {
      console.error("Could not save note:", error);
      Alert.alert("Couldn't save note", "Please try again.");
    } finally {
      setSavingNote(false);
    }
  }
  function editNote(note: Note) {
    setShowHome(false);
    setEditingNoteId(note.id);
    setNoteTitle(note.title);
    setNoteBody(note.body);
    setShowNotes(true);
  }
  async function toggleNotePin(note: Note) {
    const updated = notes.map((item) =>
      item.id === note.id
        ? { ...item, pinned: !item.pinned, updatedAt: new Date().toISOString() }
        : item,
    );
    try {
      await saveNotes(updated);
    } catch (error) {
      console.error("Could not pin note:", error);
      Alert.alert("Couldn't update note", "Please try again.");
    }
  }
  function deleteNote(note: Note) {
    Alert.alert("Delete note?", `Permanently delete "${note.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await saveNotes(notes.filter((item) => item.id !== note.id));
              if (editingNoteId === note.id) {
                clearNoteEditor();
              }
            } catch (error) {
              console.error("Could not delete note:", error);
              Alert.alert("Couldn't delete note", "Please try again.");
            }
          })();
        },
      },
    ]);
  }
  const visibleNotes = useMemo(() => {
    const query = noteSearch.trim().toLowerCase();
    return notes
      .filter(
        (note) =>
          !query ||
          note.title.toLowerCase().includes(query) ||
          note.body.toLowerCase().includes(query),
      )
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
  }, [notes, noteSearch]);
  const visibleReminders = useMemo(() => {
    return reminders
      .filter((item) => {
        if (view === "completed") return !!item.completed;
        if (item.completed) return false;
        if (view === "starred" && !item.starred) return false;
        if (view === "today") {
          const date = getTaskDate(item, new Date(now));
          const overdue =
            getRecurrence(item) === "once" &&
            new Date(item.date).getTime() < now;
          return isToday(date) || overdue;
        }
        return true;
      })
      .sort((a, b) => {
        if (view !== "completed" && !!a.starred !== !!b.starred) {
          return a.starred ? -1 : 1;
        }
        return (
          getTaskDate(a, new Date(now)).getTime() -
          getTaskDate(b, new Date(now)).getTime()
        );
      });
  }, [reminders, view, now]);
  const viewTitle: Record<AppView, string> = {
    today: "Today",
    all: "All reminders",
    starred: "Starred",
    completed: "Completed",
  };
  function renderReminder(reminder: Reminder, displayDate?: Date) {
    const completed = !!reminder.completed;
    const taskDate = displayDate ?? getTaskDate(reminder, new Date(now));
    const overdue =
      !completed &&
      getRecurrence(reminder) === "once" &&
      new Date(reminder.date).getTime() < now;
    const children = reminder.subtasks ?? [];
    const completedChildren = children.filter(
      (child) => child.completed,
    ).length;
    const expanded = expandedTasks.includes(reminder.id);
    return (
      <View key={reminder.id} style={themeStyles.taskCard}>
        <View style={themeStyles.taskTopRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              completed
                ? `Restore reminder ${reminder.title}`
                : `Complete reminder ${reminder.title}`
            }
            style={[themeStyles.checkbox, completed && themeStyles.checkboxChecked]}
            onPress={() => {
              if (completed) void restoreReminder(reminder);
              else void completeReminder(reminder);
            }}
          >
            <Text style={themeStyles.checkboxText}>{completed ? "✓" : ""}</Text>
          </Pressable>
          <Pressable
            style={themeStyles.taskMain}
            onPress={() =>
              setExpandedTasks((current) =>
                current.includes(reminder.id)
                  ? current.filter((id) => id !== reminder.id)
                  : [...current, reminder.id],
              )
            }
          >
            <Text
              style={[themeStyles.taskTitle, completed && themeStyles.completedTitle]}
            >
              {reminder.title}
            </Text>
            <Text style={[themeStyles.taskDate, overdue && themeStyles.overdueText]}>
              {overdue ? "OVERDUE · " : ""}
              {formatDate(taskDate)} · {formatTime(taskDate)}
            </Text>
            <View style={themeStyles.badgeRow}>
{getRecurrence(reminder) !== "once" && (
                <Text style={themeStyles.repeatBadge}>
                  {recurrenceLabel(reminder.recurrence)}
                </Text>
              )}
              {children.length > 0 && (
                <Text style={themeStyles.subtaskBadge}>
                  {completedChildren}/{children.length} steps
                </Text>
              )}
            </View>
          </Pressable>
          <Pressable
            style={themeStyles.starButton}
            accessibilityRole="button"
            accessibilityLabel={reminder.starred ? "Remove star" : "Star reminder"}
            onPress={() => void toggleStar(reminder)}
          >
            <Text
              style={[themeStyles.starText, reminder.starred && themeStyles.starredText]}
            >
              {reminder.starred ? "★" : "☆"}
            </Text>
          </Pressable>
          <Pressable
            style={themeStyles.deleteButton}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${reminder.title}`}
            onPress={() => void deleteReminder(reminder)}
          >
            <Text style={themeStyles.deleteText}>×</Text>
          </Pressable>
        </View>
        {expanded && (
          <View style={themeStyles.subtaskArea}>
            {children.map((child) => (
              <Pressable
                key={child.id}
                style={themeStyles.subtaskRow}
                onPress={() => void toggleSubtask(reminder, child)}
              >
                <View
                  style={[
                    themeStyles.smallCheckbox,
                    child.completed && themeStyles.checkboxChecked,
                  ]}
                >
                  <Text style={themeStyles.checkboxText}>
                    {child.completed ? "✓" : ""}
                  </Text>
                </View>
                <Text
                  style={[
                    themeStyles.subtaskTitle,
                    child.completed && themeStyles.completedTitle,
                  ]}
                >
                  {child.title}
                </Text>
              </Pressable>
            ))}
            <View style={themeStyles.addSubtaskRow}>
              <TextInput
                style={themeStyles.subtaskInput}
                value={subtaskInputs[reminder.id] ?? ""}
                onChangeText={(value) =>
                  setSubtaskInputs((current) => ({
                    ...current,
                    [reminder.id]: value,
                  }))
                }
                placeholder="Add a step..."
                placeholderTextColor="#70817F"
                returnKeyType="done"
                onSubmitEditing={() => void addSubtask(reminder)}
              />
              <Pressable
                style={themeStyles.smallAddButton}
                onPress={() => void addSubtask(reminder)}
              >
                <Text style={themeStyles.smallAddText}>+</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    );
  }
  function renderNote(note: Note) {
    const expanded = expandedNotes.includes(note.id);
    return (
      <View key={note.id} style={themeStyles.noteCard}>
        <Pressable
          style={themeStyles.noteHeader}
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Open"} note ${note.title}`}
          onPress={() => setExpandedNotes((current) => expanded ? current.filter((id) => id !== note.id) : [...current, note.id])}
        >
          <Text style={themeStyles.noteTitle} numberOfLines={2}>{note.title || "Untitled note"}</Text>
          <Text style={themeStyles.noteExpandIcon}>{expanded ? "−" : "+"}</Text>
        </Pressable>
        {expanded && (
          <>
            <View style={themeStyles.noteExpandedHeader}>
              <Text style={themeStyles.noteDate}>UPDATED {formatDate(note.updatedAt)}</Text>
              <Pressable style={themeStyles.noteIconButton} accessibilityRole="button" accessibilityLabel={note.pinned ? "Unpin note" : "Pin note"} onPress={() => void toggleNotePin(note)}>
                <Text style={themeStyles.notePinText}>{note.pinned ? "★" : "☆"}</Text>
              </Pressable>
            </View>
            {note.body.length > 0 && <Text style={themeStyles.noteBody}>{note.body}</Text>}
            <View style={themeStyles.noteActions}>
              <Pressable style={themeStyles.noteActionButton} onPress={() => editNote(note)}><Text style={themeStyles.noteActionText}>EDIT</Text></Pressable>
              <Pressable style={themeStyles.noteActionButton} onPress={() => void toggleNotePin(note)}><Text style={themeStyles.noteActionText}>{note.pinned ? "UNPIN" : "PIN"}</Text></Pressable>
              <Pressable style={themeStyles.noteActionButton} onPress={() => deleteNote(note)}><Text style={themeStyles.noteDeleteText}>DELETE</Text></Pressable>
            </View>
          </>
        )}
      </View>
    );
  }
  return (
    <SafeAreaView style={themeStyles.safeArea} edges={["top", "left", "right", "bottom"]}>
      <StatusBar barStyle={isLightTheme ? "dark-content" : "light-content"} backgroundColor={isLightTheme ? "#F3F6F5" : "#171C1E"} />
      <View style={themeStyles.header}>
        <Pressable
          style={themeStyles.logo}
          accessibilityRole="button"
          accessibilityLabel="Open navigation menu"
          onPress={() => setShowMenu(true)}
        >
          <Text style={themeStyles.logoText}>M</Text>
        </Pressable>
        <Pressable
          style={[themeStyles.logo, themeStyles.homeLogo, showHome && themeStyles.homeLogoActive]}
          accessibilityRole="button"
          accessibilityLabel="Go to home screen"
          onPress={() => {
            setShowHome(true);
            setShowNotes(false);
            setShowTaskList(false);
            setShowSettings(false);
            setShowCalendar(false);
            setShowClock(false);
            setShowMenu(false);
          }}
        >
          <Text style={themeStyles.homeLogoText}>⌂</Text>
        </Pressable>
        <View style={themeStyles.brandText}>
          <Text style={themeStyles.appName}>MATRIX</Text>
        </View>
      </View>
      <Modal
        visible={showMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMenu(false)}
      >
        <SafeAreaView
          style={themeStyles.menuOverlay}
          edges={["top", "bottom"]}
        >
          <Pressable
            style={themeStyles.menuBackdrop}
            onPress={() => setShowMenu(false)}
            accessibilityLabel="Close menu"
          />
          <View style={themeStyles.sideMenu}>
            <View style={themeStyles.menuHeader}>
              <View style={themeStyles.menuLogo}>
                <Text style={themeStyles.logoText}>M</Text>
              </View>
              <View style={themeStyles.menuBrand}>
                <Text style={themeStyles.appName}>MATRIX</Text>
                <Text style={themeStyles.menuSubtitle}>Navigation</Text>
              </View>
              <Pressable
                style={themeStyles.menuCloseButton}
                onPress={() => setShowMenu(false)}
                accessibilityRole="button"
                accessibilityLabel="Close navigation menu"
              >
                <Text style={themeStyles.menuCloseText}>×</Text>
              </Pressable>
            </View>

            <Text style={themeStyles.menuSectionLabel}>WORKSPACE</Text>
            <Pressable
              style={[
                themeStyles.menuItem,
                !showHome && !showNotes && !showSettings && !showCalendar && !showClock && themeStyles.menuItemActive,
              ]}
              onPress={() => {
                setShowHome(false);
                setShowNotes(false);
                setShowTaskList(false);
                setShowSettings(false);
                setShowCalendar(false);
                setShowClock(false);
                setShowMenu(false);
              }}
            >
              <Text style={themeStyles.menuItemIcon}>✓</Text>
              <Text
                style={[
                  themeStyles.menuItemText,
                  !showHome && !showNotes && !showSettings && !showCalendar && !showClock && themeStyles.menuItemTextActive,
                ]}
              >
                Tasks & Reminders
              </Text>
            </Pressable>
            <Pressable
              style={[themeStyles.menuItem, showCalendar && themeStyles.menuItemActive]}
              onPress={() => {
                setShowHome(false); setShowNotes(false); setShowTaskList(false); setShowSettings(false); setShowCalendar(true); setShowClock(false); setShowMenu(false);
              }}
            >
              <Text style={themeStyles.menuItemIcon}>▦</Text>
              <Text style={[themeStyles.menuItemText, showCalendar && themeStyles.menuItemTextActive]}>Calendar</Text>
            </Pressable>
            <Pressable
              style={[themeStyles.menuItem, showClock && themeStyles.menuItemActive]}
              onPress={() => {
                setShowHome(false); setShowNotes(false); setShowTaskList(false); setShowSettings(false); setShowCalendar(false); setShowClock(true); setShowMenu(false);
              }}
            >
              <Text style={themeStyles.menuItemIcon}>◷</Text>
              <Text style={[themeStyles.menuItemText, showClock && themeStyles.menuItemTextActive]}>Clock & Alarms</Text>
            </Pressable>
            <Pressable
              style={[themeStyles.menuItem, showNotes && themeStyles.menuItemActive]}
              onPress={() => {
                setShowHome(false);
                setShowNotes(true);
                setShowTaskList(false);
                setShowSettings(false);
                setShowCalendar(false);
                setShowClock(false);
                setShowMenu(false);
              }}
            >
              <Text style={themeStyles.menuItemIcon}>✎</Text>
              <Text
                style={[themeStyles.menuItemText, showNotes && themeStyles.menuItemTextActive]}
              >
                Notes
              </Text>
            </Pressable>

            <View style={themeStyles.menuDivider} />
            <Text style={themeStyles.menuSectionLabel}>PREFERENCES</Text>
            <Pressable
              style={[themeStyles.menuItem, showSettings && themeStyles.menuItemActive]}
              onPress={() => {
                setShowHome(false);
                setShowNotes(false);
                setShowTaskList(false);
                setShowSettings(true);
                setShowCalendar(false);
                setShowClock(false);
                setShowMenu(false);
              }}
            >
              <Text style={themeStyles.menuItemIcon}>⚙</Text>
              <Text
                style={[themeStyles.menuItemText, showSettings && themeStyles.menuItemTextActive]}
              >
                Settings
              </Text>
            </Pressable>

            <View style={themeStyles.menuFooter}>
              <Text style={themeStyles.menuFooterText}>MATRIX</Text>
              <Text style={themeStyles.menuFooterSubtext}>Simple by design</Text>
            </View>
          </View>
        </SafeAreaView>
      </Modal>
      <ScrollView
        style={themeStyles.list}
        contentContainerStyle={themeStyles.content}
        keyboardShouldPersistTaps="handled"
      >
        {showHome ? (
          <View style={themeStyles.homeScreen}>
            <View style={themeStyles.homeDateBlock}>
              <Text style={themeStyles.homeEyebrow}>YOUR DAY</Text>
              <Text style={themeStyles.heading}>{new Date(now).toLocaleDateString([], { weekday: "long" })}</Text>
              <Text style={themeStyles.homeDate}>{new Date(now).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</Text>
            </View>

            <View style={themeStyles.homeSectionHeader}>
              <Text style={themeStyles.sectionTitle}>TODAY'S REMINDERS</Text>
              <View style={themeStyles.homeSectionActions}>
                <Text style={themeStyles.count}>{reminders.filter((item) => !item.completed && reminderOccursOnDate(item, new Date(now))).length}</Text>
                <Pressable style={themeStyles.homeTextButton} onPress={() => { setShowHome(false); setShowTaskList(false); setShowNotes(false); setShowSettings(false); setShowCalendar(false); setShowClock(false); }}>
                  <Text style={themeStyles.homeTextButtonText}>ALL</Text>
                </Pressable>
              </View>
            </View>
            {loading ? (
              <Text style={themeStyles.emptyText}>Loading today's reminders...</Text>
            ) : reminders.filter((item) => !item.completed && reminderOccursOnDate(item, new Date(now))).length === 0 ? (
              <View style={themeStyles.emptyCard}>
                <Text style={themeStyles.emptyIcon}>◷</Text>
                <Text style={themeStyles.emptyTitle}>Nothing scheduled yet</Text>
                <Text style={themeStyles.emptyText}>Reminders scheduled for today will appear here.</Text>
              </View>
            ) : (
              reminders
                .filter((item) => !item.completed && reminderOccursOnDate(item, new Date(now)))
                .sort((a, b) => getReminderOccurrenceDate(a, new Date(now)).getTime() - getReminderOccurrenceDate(b, new Date(now)).getTime())
                .map((item) => renderReminder(item, getReminderOccurrenceDate(item, new Date(now))))
            )}

            <View style={[themeStyles.homeSectionHeader, themeStyles.homeAlarmHeader]}>
              <Text style={themeStyles.sectionTitle}>TODAY'S ALARMS</Text>
              <Text style={themeStyles.count}>{alarms.filter((alarm) => alarm.enabled).length}</Text>
            </View>
            {alarms.filter((alarm) => alarm.enabled).length === 0 ? (
              <View style={themeStyles.emptyCard}>
                <Text style={themeStyles.emptyIcon}>◴</Text>
                <Text style={themeStyles.emptyTitle}>No active alarms</Text>
                <Text style={themeStyles.emptyText}>Alarms you enable will appear here.</Text>
                <Pressable style={themeStyles.homeTextButton} onPress={() => { setShowHome(false); setShowClock(true); setClockTab("alarm"); }}>
                  <Text style={themeStyles.homeTextButtonText}>OPEN CLOCK & ALARMS</Text>
                </Pressable>
              </View>
            ) : (
              alarms.filter((alarm) => alarm.enabled)
                .slice().sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
                .map((alarm) => (
                  <Pressable key={alarm.id} style={themeStyles.homeAlarmRow} onPress={() => { setShowHome(false); setShowClock(true); setClockTab("alarm"); }}>
                    <View style={themeStyles.homeAlarmIcon}><Text style={themeStyles.homeAlarmIconText}>◴</Text></View>
                    <View style={themeStyles.homeAlarmCopy}>
                      <Text style={themeStyles.homeAlarmTime}>{formatTime(new Date(2000, 0, 1, alarm.hour, alarm.minute))}</Text>
                      <Text style={themeStyles.settingsHelp}>Every day · {alarm.sound === "silent" ? "Silent" : "Alarm enabled"}</Text>
                    </View>
                    <Text style={themeStyles.homeAlarmArrow}>›</Text>
                  </Pressable>
                ))
            )}
            <Text style={themeStyles.bottomNote}>MATRIX · SIMPLE BY DESIGN</Text>
          </View>
        ) : showClock ? (
          <View style={themeStyles.clockScreen}>
            <View style={themeStyles.pageTitleRow}><Text style={themeStyles.heading}>Clock</Text><Pressable style={themeStyles.backButton} onPress={() => setShowClock(false)}><Text style={themeStyles.backButtonText}>TASKS</Text></Pressable></View>
            <View style={themeStyles.clockTabs}>
              {([ ["alarm", "Alarm"], ["timer", "Timer"], ["stopwatch", "Stopwatch"] ] as [ClockTab, string][]).map(([key, label]) => <Pressable key={key} style={[themeStyles.clockTab, clockTab === key && themeStyles.clockTabActive]} onPress={() => setClockTab(key)}><Text style={[themeStyles.clockTabText, clockTab === key && themeStyles.clockTabTextActive]}>{label}</Text></Pressable>)}
            </View>
            {clockTab === "alarm" ? (
              <View style={themeStyles.clockCard}>
                <Text style={themeStyles.sectionTitle}>ALARMS</Text>
                <Pressable style={themeStyles.clockPrimaryButton} onPress={() => { const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1); setAlarmTime(d); setAlarmSound("default"); setShowAlarmModal(true); }}><Text style={themeStyles.clockPrimaryText}>＋ ADD ALARM</Text></Pressable>
                {alarms.length === 0 ? <Text style={themeStyles.settingsHelp}>No alarms yet. Add your first alarm.</Text> : alarms.slice().sort((a,b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)).map((alarm) => <View key={alarm.id} style={themeStyles.alarmRow}><Pressable style={themeStyles.alarmTimeArea} onPress={() => void toggleAlarm(alarm)}><Text style={[themeStyles.alarmTime, !alarm.enabled && themeStyles.alarmDisabled]}>{formatTime(new Date(2000, 0, 1, alarm.hour, alarm.minute))}</Text><Text style={themeStyles.settingsHelp}>Every day · {alarm.sound === "silent" ? "Silent" : "Default phone notification sound"}</Text></Pressable><Switch value={alarm.enabled} onValueChange={() => void toggleAlarm(alarm)} trackColor={{ false: "#455155", true: "#167E73" }} thumbColor={alarm.enabled ? "#48D6C1" : "#A7B8B6"} /><Pressable style={themeStyles.alarmDeleteButton} onPress={() => void deleteAlarm(alarm)}><Text style={themeStyles.alarmDeleteText}>×</Text></Pressable></View>)}
              </View>
            ) : clockTab === "timer" ? (
              <View style={themeStyles.clockCard}>
                <Text style={themeStyles.sectionTitle}>TIMER</Text>
                <Text style={themeStyles.clockTimerDisplay}>{formatDuration(timerCompleted ? 0 : timerEndAt !== null || timerRemaining > 0 ? timerRemaining : Number(timerHours) * 3600 + Number(timerMinutes) * 60 + Number(timerSeconds))}</Text>
                {timerEndAt === null && timerRemaining === 0 ? <View style={themeStyles.timerInputs}><View style={themeStyles.timerInputGroup}><Text style={themeStyles.label}>HOURS</Text><TextInput style={themeStyles.timerInput} keyboardType="number-pad" value={timerHours} onChangeText={(v) => setTimerHours(v.replace(/[^0-9]/g, "").slice(0, 2))} maxLength={2} /></View><View style={themeStyles.timerInputGroup}><Text style={themeStyles.label}>MINUTES</Text><TextInput style={themeStyles.timerInput} keyboardType="number-pad" value={timerMinutes} onChangeText={(v) => setTimerMinutes(v.replace(/[^0-9]/g, "").slice(0, 2))} maxLength={2} /></View><View style={themeStyles.timerInputGroup}><Text style={themeStyles.label}>SECONDS</Text><TextInput style={themeStyles.timerInput} keyboardType="number-pad" value={timerSeconds} onChangeText={(v) => setTimerSeconds(v.replace(/[^0-9]/g, "").slice(0, 2))} maxLength={2} /></View></View> : <Text style={themeStyles.settingsHelp}>Timer running</Text>}
                <View style={themeStyles.clockControls}>{timerEndAt === null ? <Pressable style={themeStyles.clockPrimaryButton} onPress={() => void startTimer()}><Text style={themeStyles.clockPrimaryText}>{timerRemaining > 0 ? "RESUME TIMER" : "START TIMER"}</Text></Pressable> : <Pressable style={themeStyles.clockPrimaryButton} onPress={() => void stopTimer()}><Text style={themeStyles.clockPrimaryText}>CANCEL TIMER</Text></Pressable>}{timerRemaining > 0 && timerEndAt === null && <Pressable style={themeStyles.clockSecondaryButton} onPress={() => void stopTimer()}><Text style={themeStyles.clockSecondaryText}>RESET</Text></Pressable>}</View>
              </View>
            ) : (
              <View style={themeStyles.clockCard}>
                <Text style={themeStyles.sectionTitle}>STOPWATCH</Text>
                <Text style={themeStyles.clockTimerDisplay}>{formatStopwatch(stopwatchElapsed)}</Text>
                <View style={themeStyles.clockControls}><Pressable style={themeStyles.clockPrimaryButton} onPress={() => { if (stopwatchRunning) { setStopwatchRunning(false); setStopwatchStartedAt(null); } else { setStopwatchRunning(true); setStopwatchStartedAt(Date.now() - stopwatchElapsed); } }}><Text style={themeStyles.clockPrimaryText}>{stopwatchRunning ? "PAUSE" : stopwatchElapsed > 0 ? "RESUME" : "START"}</Text></Pressable><Pressable style={themeStyles.clockSecondaryButton} onPress={() => { setStopwatchRunning(false); setStopwatchStartedAt(null); setStopwatchElapsed(0); }}><Text style={themeStyles.clockSecondaryText}>RESET</Text></Pressable></View>
              </View>
            )}
          </View>
        ) : showSettings ? (
          <View style={themeStyles.settingsPlaceholder}>
            <Text style={themeStyles.heading}>Settings</Text>
            <Text style={themeStyles.description}>Personalize how Matrix looks and works.</Text>
            <Text style={themeStyles.sectionTitle}>APPEARANCE</Text>
            <View style={themeStyles.settingsCard}>
              <Text style={themeStyles.settingsTitle}>Theme</Text>
              <Text style={themeStyles.settingsHelp}>Choose how Matrix appears on your phone.</Text>
              <View style={themeStyles.settingChoices}>
                {([ ["default", "Default"], ["dark", "Dark"], ["light", "Light"], ["system", "System"] ] as [AppSettings["theme"], string][]).map(([value, label]) => (
                  <Pressable key={value} style={[themeStyles.settingChoice, settings.theme === value && themeStyles.settingChoiceActive]} onPress={() => void updateSetting("theme", value)}>
                    <Text style={[themeStyles.settingChoiceText, settings.theme === value && themeStyles.settingChoiceTextActive]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={themeStyles.settingsHelp}>Default and Dark keep the current Matrix look. Light uses a bright layout, while System follows your phone's appearance setting.</Text>
            </View>
            <Text style={themeStyles.sectionTitle}>REMINDERS</Text>
            <View style={themeStyles.settingsCard}>
              <View style={themeStyles.settingRow}><View style={themeStyles.settingCopy}><Text style={themeStyles.settingsTitle}>Notifications</Text><Text style={themeStyles.settingsHelp}>Schedule alerts when creating new reminders.</Text></View><Switch value={settings.notificationsEnabled} onValueChange={(value) => void updateSetting("notificationsEnabled", value)} trackColor={{ false: "#455155", true: "#167E73" }} thumbColor={settings.notificationsEnabled ? "#48D6C1" : "#A7B8B6"} /></View>
              <Text style={themeStyles.settingsTitle}>Default snooze</Text>
              <View style={themeStyles.settingChoices}>{([5, 15, 30, 60] as number[]).map((minutes) => <Pressable key={minutes} style={[themeStyles.settingChoice, settings.defaultSnoozeMinutes === minutes && themeStyles.settingChoiceActive]} onPress={() => void updateSetting("defaultSnoozeMinutes", minutes)}><Text style={[themeStyles.settingChoiceText, settings.defaultSnoozeMinutes === minutes && themeStyles.settingChoiceTextActive]}>{minutes < 60 ? `${minutes} min` : "1 hour"}</Text></Pressable>)}</View>
            </View>
            <Text style={themeStyles.sectionTitle}>PRODUCTIVITY</Text>
            <View style={themeStyles.settingsCard}>
              <View style={themeStyles.settingRow}><View style={themeStyles.settingCopy}><Text style={themeStyles.settingsTitle}>Week starts Monday</Text><Text style={themeStyles.settingsHelp}>Use Monday instead of Sunday in Calendar.</Text></View><Switch value={settings.weekStartsMonday} onValueChange={(value) => void updateSetting("weekStartsMonday", value)} trackColor={{ false: "#455155", true: "#167E73" }} thumbColor={settings.weekStartsMonday ? "#48D6C1" : "#A7B8B6"} /></View>
              <View style={themeStyles.settingRow}><View style={themeStyles.settingCopy}><Text style={themeStyles.settingsTitle}>Hide completed reminders</Text><Text style={themeStyles.settingsHelp}>Keep finished items out of the active calendar.</Text></View><Switch value={settings.hideCompleted} onValueChange={(value) => void updateSetting("hideCompleted", value)} trackColor={{ false: "#455155", true: "#167E73" }} thumbColor={settings.hideCompleted ? "#48D6C1" : "#A7B8B6"} /></View>
            </View>
            <Text style={themeStyles.sectionTitle}>ABOUT</Text>
            <View style={themeStyles.settingsCard}><Text style={themeStyles.settingsTitle}>Matrix</Text><Text style={themeStyles.settingsHelp}>Version 1.0.0 · Your notes and reminders are stored on this device.</Text></View>
          </View>
        ) : showCalendar ? (
          <View style={themeStyles.calendarScreen}>
            <View style={themeStyles.pageTitleRow}><Text style={themeStyles.heading}>Calendar</Text><Pressable style={themeStyles.backButton} onPress={() => setShowCalendar(false)}><Text style={themeStyles.backButtonText}>TASKS</Text></Pressable></View>
            <View style={themeStyles.calendarMonthHeader}>
              <Pressable style={themeStyles.calendarArrow} onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}><Text style={themeStyles.calendarArrowText}>‹</Text></Pressable>
              <Text style={themeStyles.calendarMonthTitle}>{calendarMonth.toLocaleDateString([], { month: "long", year: "numeric" })}</Text>
              <Pressable style={themeStyles.calendarArrow} onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}><Text style={themeStyles.calendarArrowText}>›</Text></Pressable>
            </View>
            <View style={themeStyles.calendarGrid}>
              {(settings.weekStartsMonday ? ["M", "T", "W", "T", "F", "S", "S"] : ["S", "M", "T", "W", "T", "F", "S"]).map((day, i) => <Text key={`${day}-${i}`} style={themeStyles.calendarWeekday}>{day}</Text>)}
              {(() => {
                const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
                const offset = (first.getDay() + (settings.weekStartsMonday ? 6 : 0)) % 7;
                const days = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
                const cells: (Date | null)[] = [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), i + 1))];
                while (cells.length % 7) cells.push(null);
                return cells.map((date, i) => {
                  if (!date) return <View key={`blank-${i}`} style={themeStyles.calendarDayCell} />;
                  const hasReminder = reminders.some((item) => {
                    if (settings.hideCompleted && item.completed) return false;
                    const base = new Date(item.date);
                    if (Number.isNaN(base.getTime())) return false;
                    if (getRecurrence(item) === "daily") return date >= new Date(base.getFullYear(), base.getMonth(), base.getDate()) || date.toDateString() === base.toDateString();
                    if (getRecurrence(item) === "weekly") return date.getDay() === base.getDay() && date >= new Date(base.getFullYear(), base.getMonth(), base.getDate());
                    if (getRecurrence(item) === "monthly") return date.getDate() === base.getDate() && date >= new Date(base.getFullYear(), base.getMonth(), base.getDate());
                    if (getRecurrence(item) === "yearly") return date.getMonth() === base.getMonth() && date.getDate() === base.getDate() && date >= new Date(base.getFullYear(), base.getMonth(), base.getDate());
                    return date.toDateString() === base.toDateString();
                  });
                  const selected = date.toDateString() === selectedCalendarDate.toDateString();
                  const today = date.toDateString() === new Date().toDateString();
                  return <Pressable key={date.toISOString()} style={[themeStyles.calendarDayCell, selected && themeStyles.calendarDaySelected, today && themeStyles.calendarDayToday]} onPress={() => setSelectedCalendarDate(date)}><Text style={[themeStyles.calendarDayText, selected && themeStyles.calendarDayTextSelected]}>{date.getDate()}</Text>{hasReminder && <View style={[themeStyles.calendarDot, selected && themeStyles.calendarDotSelected]} />}</Pressable>;
                });
              })()}
            </View>
            <View style={themeStyles.calendarSelectedHeader}><View><Text style={themeStyles.sectionTitle}>{selectedCalendarDate.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }).toUpperCase()}</Text><Text style={themeStyles.settingsHelp}>Active reminders on this date</Text></View><Pressable style={themeStyles.calendarAddButton} onPress={startReminderFromCalendar}><Text style={themeStyles.calendarAddText}>+ ADD</Text></Pressable></View>
            {reminders.filter((item) => {
              if (settings.hideCompleted && item.completed) return false;
              const base = new Date(item.date); const date = selectedCalendarDate;
              if (Number.isNaN(base.getTime())) return false;
              if (getRecurrence(item) === "daily") return date >= new Date(base.getFullYear(), base.getMonth(), base.getDate());
              if (getRecurrence(item) === "weekly") return date.getDay() === base.getDay() && date >= new Date(base.getFullYear(), base.getMonth(), base.getDate());
              if (getRecurrence(item) === "monthly") return date.getDate() === base.getDate() && date >= new Date(base.getFullYear(), base.getMonth(), base.getDate());
              if (getRecurrence(item) === "yearly") return date.getMonth() === base.getMonth() && date.getDate() === base.getDate() && date >= new Date(base.getFullYear(), base.getMonth(), base.getDate());
              return date.toDateString() === base.toDateString();
            }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((item) => <Pressable key={item.id} style={themeStyles.calendarReminder} onPress={() => { setShowCalendar(false); setShowNotes(false); setShowSettings(false); setShowTaskList(true); setView("all"); }}><Text style={themeStyles.calendarReminderTime}>{formatTime(new Date(item.date))}</Text><View style={themeStyles.calendarReminderInfo}><Text style={themeStyles.calendarReminderTitle}>{item.title}</Text><Text style={themeStyles.settingsHelp}>{recurrenceLabel(getRecurrence(item))}</Text></View></Pressable>)}
          </View>
        ) : showNotes ? (
          <>
            <Text style={themeStyles.heading}>Your notes</Text>
            <View style={themeStyles.form}>
              <Text style={themeStyles.formTitle}>
                {editingNoteId ? "EDIT NOTE" : "CREATE A NOTE"}
              </Text>
              <Text style={themeStyles.label}>TITLE</Text>
              <TextInput
                style={themeStyles.input}
                value={noteTitle}
                onChangeText={setNoteTitle}
                
                placeholderTextColor="#70817F"
                maxLength={120}
              />
              <Text style={themeStyles.label}>NOTE</Text>
              <TextInput
                style={[themeStyles.input, themeStyles.noteBodyInput]}
                value={noteBody}
                onChangeText={setNoteBody}
                
                placeholderTextColor="#70817F"
                multiline
                textAlignVertical="top"
                maxLength={10000}
              />
              <Pressable
                style={[themeStyles.addButton, savingNote && themeStyles.buttonDisabled]}
                disabled={savingNote}
                onPress={() => void saveNote()}
              >
                <Text style={themeStyles.addButtonText}>
                  {savingNote
                    ? "SAVING..."
                    : editingNoteId
                      ? "SAVE CHANGES"
                      : "+  SAVE NOTE"}
                </Text>
              </Pressable>
              {editingNoteId && (
                <Pressable
                  style={themeStyles.cancelEditButton}
                  onPress={clearNoteEditor}
                >
                  <Text style={themeStyles.cancelEditText}>CANCEL EDITING</Text>
                </Pressable>
              )}
            </View>
            <TextInput
              style={[themeStyles.input, themeStyles.noteSearch]}
              value={noteSearch}
              onChangeText={setNoteSearch}
              placeholder="Search your notes..."
              placeholderTextColor="#70817F"
              clearButtonMode="while-editing"
            />
            <View style={themeStyles.tasksHeadingRow}>
              <Text style={themeStyles.sectionTitle}>SAVED NOTES</Text>
            </View>
            {visibleNotes.length === 0 ? (
              <View style={themeStyles.emptyCard}>
                <Text style={themeStyles.emptyIcon}>✎</Text>
                <Text style={themeStyles.emptyTitle}>
                  {noteSearch.trim() ? "No matching notes" : "No notes yet"}
                </Text>
                <Text style={themeStyles.emptyText}>
                  {noteSearch.trim()
                    ? "Try a different search."
                    : "Create a note above to save an idea or plan."}
                </Text>
              </View>
            ) : (
              visibleNotes.map(renderNote)
            )}
            <Text style={themeStyles.bottomNote}>
              NOTES STAY ON THIS DEVICE · MATRIX
            </Text>
          </>
        ) : showTaskList ? (
          <>
            <View style={themeStyles.pageTitleRow}>
              <Text style={themeStyles.heading}>Reminder List</Text>
              <Pressable
                style={themeStyles.backButton}
                onPress={() => setShowTaskList(false)}
              >
                <Text style={themeStyles.backButtonText}>BACK</Text>
              </Pressable>
            </View>
            <View style={themeStyles.viewTabs}>
              {(
                [
                  ["today", "Today"],
                  ["all", "All"],
                  ["starred", "★ Starred"],
                  ["completed", "Done"],
                ] as [AppView, string][]
              ).map(([key, label]) => (
                <Pressable
                  key={key}
                  onPress={() => setView(key)}
                  style={[themeStyles.viewTab, view === key && themeStyles.viewTabActive]}
                >
                  <Text
                    style={[
                      themeStyles.viewTabText,
                      view === key && themeStyles.viewTabTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={themeStyles.tasksHeadingRow}>
              <Text style={themeStyles.sectionTitle}>
                {viewTitle[view].toUpperCase()}
              </Text>
              <Text style={themeStyles.count}>{visibleReminders.length}</Text>
            </View>
            {loading ? (
              <Text style={themeStyles.emptyText}>Loading your reminders...</Text>
            ) : visibleReminders.length === 0 ? (
              <View style={themeStyles.emptyCard}>
                <Text style={themeStyles.emptyIcon}>
                  {view === "completed" ? "✓" : view === "starred" ? "☆" : "◷"}
                </Text>
                <Text style={themeStyles.emptyTitle}>
                  {view === "completed"
                    ? "No completed reminders yet"
                    : view === "starred"
                      ? "No starred reminders"
                      : view === "today"
                        ? "You're all caught up"
                        : "No reminders in this view"}
                </Text>
                <Text style={themeStyles.emptyText}>
                  {view === "today"
                    ? "Reminders due today and overdue reminders will appear here."
                    : "Create a reminder to get started."}
                </Text>
              </View>
            ) : (
              visibleReminders.map((reminder) => renderReminder(reminder))
            )}
            <Text style={themeStyles.bottomNote}>
              Reminders stay on this device. MATRIX · SIMPLE BY DESIGN
            </Text>
          </>
        ) : (
          <>
            <View style={themeStyles.pageTitleRow}>
              <Text style={themeStyles.heading}>Reminders</Text>
              <Pressable style={themeStyles.backButton} onPress={() => { setShowCalendar(true); setShowTaskList(false); setCalendarMonth(new Date(selectedCalendarDate.getFullYear(), selectedCalendarDate.getMonth(), 1)); }}>
                <Text style={themeStyles.backButtonText}>CALENDAR</Text>
              </Pressable>
            </View>
            <View style={themeStyles.form}>
              <Text style={themeStyles.formTitle}>CREATE A REMINDER</Text>
              <Text style={themeStyles.label}>WHAT DO YOU NEED TO BE REMINDED ABOUT?</Text>
              <TextInput
                style={themeStyles.input}
                value={title}
                onChangeText={setTitle}
                returnKeyType="next"
                maxLength={150}
              />
              <Text style={themeStyles.label}>ADD CHECKLIST STEPS (OPTIONAL)</Text>
              <TextInput
                style={[themeStyles.input, themeStyles.multilineInput]}
                value={subtaskDraft}
                onChangeText={setSubtaskDraft}
                multiline
                textAlignVertical="top"
                maxLength={1200}
              />
              <Text style={themeStyles.label}>WHEN SHOULD WE REMIND YOU?</Text>
              <View style={themeStyles.dateRow}>
                <Pressable
                  style={themeStyles.dateButton}
                  onPress={() => setShowScheduleModal(true)}
                >
                  <Text style={themeStyles.dateIcon}>▦</Text>
                  <View>
                    <Text style={themeStyles.dateCaption}>DATE</Text>
                    <Text style={themeStyles.dateValue}>
                      {formatDate(reminderDate)}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  style={themeStyles.dateButton}
                  onPress={() => setShowScheduleModal(true)}
                >
                  <Text style={themeStyles.dateIcon}>◷</Text>
                  <View>
                    <Text style={themeStyles.dateCaption}>TIME</Text>
                    <Text style={themeStyles.dateValue}>
                      {formatTime(reminderDate)}
                    </Text>
                  </View>
                </Pressable>
              </View>
              <Text style={themeStyles.repeatHint}>
                {recurrenceLabel(recurrence)} · Tap the schedule above to change date, time, or repeat.
              </Text>
              <Pressable
                style={[
                  themeStyles.addButton,
                  (saving || loading) && themeStyles.buttonDisabled,
                ]}
                onPress={() => void addReminder()}
                disabled={saving || loading}
              >
                <Text style={themeStyles.addButtonText}>
                  {saving ? "SAVING..." : "+  CREATE REMINDER"}
                </Text>
              </Pressable>
            </View>
            <Pressable
              style={themeStyles.taskListButton}
              onPress={() => { setShowHome(false); setShowTaskList(true); }}
            >
              <Text style={themeStyles.taskListButtonText}>VIEW REMINDER LIST</Text>
              <Text style={themeStyles.taskListButtonCount}>
                {reminders.filter((reminder) => !reminder.completed).length}
              </Text>
            </Pressable>
            <Text style={themeStyles.bottomNote}>
              Reminders stay on this device. MATRIX · SIMPLE BY DESIGN
            </Text>
          </>

        )}
      </ScrollView>
      <Modal
        visible={showAlarmModal}
        transparent
        animationType="fade"
        onRequestClose={() => { setShowAlarmModal(false); setShowAlarmTimePicker(false); }}
      >
        <View style={themeStyles.modalOverlay}>
          <View style={themeStyles.scheduleModal}>
            <Text style={themeStyles.modalTitle}>CREATE ALARM</Text>
            <Text style={themeStyles.modalSubtitle}>Choose when Matrix should alert you every day.</Text>
            <Pressable style={themeStyles.clockTimePickerButton} onPress={() => setShowAlarmTimePicker(true)}>
              <Text style={themeStyles.clockBigTime}>{formatTime(alarmTime)}</Text>
              <Text style={themeStyles.settingsHelp}>Tap to choose alarm time</Text>
            </Pressable>
            {showAlarmTimePicker && Platform.OS === "ios" && <DateTimePicker value={alarmTime} mode="time" display="spinner" onChange={(event, date) => { if (event.type === "set" && date) setAlarmTime(date); }} />}
            {showAlarmTimePicker && Platform.OS === "android" && <DateTimePicker value={alarmTime} mode="time" onChange={(event, date) => { setShowAlarmTimePicker(false); if (event.type === "set" && date) setAlarmTime(date); }} />}
            <Text style={themeStyles.label}>ALARM SOUND</Text>
            <View style={themeStyles.settingChoices}>
              <Pressable style={[themeStyles.settingChoice, alarmSound === "default" && themeStyles.settingChoiceActive]} onPress={() => setAlarmSound("default")}><Text style={[themeStyles.settingChoiceText, alarmSound === "default" && themeStyles.settingChoiceTextActive]}>Default phone sound</Text></Pressable>
              <Pressable style={[themeStyles.settingChoice, alarmSound === "silent" && themeStyles.settingChoiceActive]} onPress={() => setAlarmSound("silent")}><Text style={[themeStyles.settingChoiceText, alarmSound === "silent" && themeStyles.settingChoiceTextActive]}>Silent</Text></Pressable>
            </View>
            <Text style={themeStyles.settingsHelp}>Default currently uses Android's notification sound. A Clock-style alarm tone and system alarm-sound picker require native Android alarm support.</Text>
            <View style={themeStyles.modalActions}>
              <Pressable style={themeStyles.modalSecondaryButton} onPress={() => { setShowAlarmModal(false); setShowAlarmTimePicker(false); }}><Text style={themeStyles.modalSecondaryText}>CANCEL</Text></Pressable>
              <Pressable style={themeStyles.modalPrimaryButton} onPress={() => void addAlarm()}><Text style={themeStyles.modalPrimaryText}>SAVE ALARM</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={showCalendarReminderModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCalendarReminderModal(false)}
      >
        <View style={themeStyles.modalOverlay}>
          <View style={themeStyles.scheduleModal}>
            <Text style={themeStyles.modalTitle}>CREATE REMINDER</Text>
            <Text style={themeStyles.modalSubtitle}>For {selectedCalendarDate.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</Text>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={themeStyles.label}>WHAT DO YOU NEED TO BE REMINDED ABOUT?</Text>
              <TextInput style={themeStyles.input} value={title} onChangeText={setTitle} maxLength={150} autoFocus />
              <Text style={themeStyles.label}>CHECKLIST STEPS (OPTIONAL)</Text>
              <TextInput style={[themeStyles.input, themeStyles.multilineInput]} value={subtaskDraft} onChangeText={setSubtaskDraft} multiline textAlignVertical="top" maxLength={1200} />
              <Text style={themeStyles.label}>DATE & TIME</Text>
              <View style={themeStyles.dateRow}>
                <Pressable style={themeStyles.dateButton} onPress={() => setShowScheduleModal(true)}><Text style={themeStyles.dateIcon}>▦</Text><View><Text style={themeStyles.dateCaption}>DATE</Text><Text style={themeStyles.dateValue}>{formatDate(reminderDate)}</Text></View></Pressable>
                <Pressable style={themeStyles.dateButton} onPress={() => setShowScheduleModal(true)}><Text style={themeStyles.dateIcon}>◷</Text><View><Text style={themeStyles.dateCaption}>TIME</Text><Text style={themeStyles.dateValue}>{formatTime(reminderDate)}</Text></View></Pressable>
              </View>
              <Text style={themeStyles.repeatHint}>{recurrenceLabel(recurrence)} · Tap date or time to change schedule.</Text>
              <View style={themeStyles.modalActions}>
                <Pressable style={themeStyles.modalSecondaryButton} onPress={() => setShowCalendarReminderModal(false)}><Text style={themeStyles.modalSecondaryText}>CANCEL</Text></Pressable>
                <Pressable style={[themeStyles.modalPrimaryButton, (saving || loading) && themeStyles.buttonDisabled]} disabled={saving || loading} onPress={() => void addReminder()}><Text style={themeStyles.modalPrimaryText}>{saving ? "SAVING..." : "CREATE"}</Text></Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        visible={showScheduleModal}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowScheduleModal(false);
          setShowDatePicker(false);
          setShowTimePicker(false);
        }}
      >
        <View style={themeStyles.modalOverlay}>
          <View style={themeStyles.scheduleModal}>
            <Text style={themeStyles.modalTitle}>SCHEDULE REMINDER</Text>
            <Text style={themeStyles.modalSubtitle}>Choose when it happens and how often it repeats.</Text>
            <View style={themeStyles.dateRow}>
              <Pressable
                style={themeStyles.dateButton}
                onPress={() => {
                  setShowTimePicker(false);
                  setShowDatePicker(true);
                }}
              >
                <Text style={themeStyles.dateIcon}>▦</Text>
                <View>
                  <Text style={themeStyles.dateCaption}>DATE</Text>
                  <Text style={themeStyles.dateValue}>{formatDate(reminderDate)}</Text>
                </View>
              </Pressable>
              <Pressable
                style={themeStyles.dateButton}
                onPress={() => {
                  setShowDatePicker(false);
                  setShowTimePicker(true);
                }}
              >
                <Text style={themeStyles.dateIcon}>◷</Text>
                <View>
                  <Text style={themeStyles.dateCaption}>TIME</Text>
                  <Text style={themeStyles.dateValue}>{formatTime(reminderDate)}</Text>
                </View>
              </Pressable>
            </View>
            {Platform.OS === "ios" && showDatePicker && (
              <DateTimePicker
                value={reminderDate}
                mode="date"
                display="spinner"
                minimumDate={new Date()}
                onChange={(event, selectedDate) => {
                  if (event.type === "set" && selectedDate) {
                    setReminderDate((current) => {
                      const updated = new Date(current);
                      updated.setFullYear(
                        selectedDate.getFullYear(),
                        selectedDate.getMonth(),
                        selectedDate.getDate(),
                      );
                      return updated;
                    });
                  }
                }}
              />
            )}
            {Platform.OS === "ios" && showTimePicker && (
              <DateTimePicker
                value={reminderDate}
                mode="time"
                display="spinner"
                onChange={(event, selectedTime) => {
                  if (event.type === "set" && selectedTime) {
                    setReminderDate((current) => {
                      const updated = new Date(current);
                      updated.setHours(
                        selectedTime.getHours(),
                        selectedTime.getMinutes(),
                        0,
                        0,
                      );
                      return updated;
                    });
                  }
                }}
              />
            )}
            <Text style={themeStyles.label}>REPEAT</Text>
            <View style={themeStyles.recurrenceRow}>
              {(["daily", "weekly", "monthly", "yearly"] as Recurrence[]).map((option) => (
                <Pressable
                  key={option}
                  onPress={() => setRecurrence(option)}
                  style={[
                    themeStyles.recurrenceButton,
                    recurrence === option && themeStyles.recurrenceButtonActive,
                  ]}
                >
                  <Text
                    style={[
                      themeStyles.recurrenceText,
                      recurrence === option && themeStyles.recurrenceTextActive,
                    ]}
                  >
                    {option[0].toUpperCase() + option.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={themeStyles.repeatHint}>
              {recurrence === "once"
                ? "One-time reminder by default. Select a repeat option to make it recurring."
                : recurrence === "daily"
                  ? "Repeat every day at the selected time."
                  : recurrence === "weekly"
                    ? `Repeat every ${reminderDate.toLocaleDateString([], { weekday: "long" })}.`
                    : recurrence === "monthly"
                      ? `Repeat on day ${reminderDate.getDate()} of each month.`
                      : `Repeat every year on ${reminderDate.toLocaleDateString([], { month: "long", day: "numeric" })}.`}
            </Text>
            <View style={themeStyles.modalActions}>
              <Pressable
                style={themeStyles.modalSecondaryButton}
                onPress={() => {
                  setShowScheduleModal(false);
                  setShowDatePicker(false);
                  setShowTimePicker(false);
                }}
              >
                <Text style={themeStyles.modalSecondaryText}>CANCEL</Text>
              </Pressable>
              <Pressable
                style={themeStyles.modalPrimaryButton}
                onPress={() => {
                  setShowScheduleModal(false);
                  setShowDatePicker(false);
                  setShowTimePicker(false);
                }}
              >
                <Text style={themeStyles.modalPrimaryText}>DONE</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      {Platform.OS === "android" && showScheduleModal && showDatePicker && (
        <DateTimePicker
          value={reminderDate}
          mode="date"
          minimumDate={new Date()}
          onChange={(event, selectedDate) => {
            setShowDatePicker(false);
            if (event.type === "set" && selectedDate) {
              setReminderDate((current) => {
                const updated = new Date(current);
                updated.setFullYear(
                  selectedDate.getFullYear(),
                  selectedDate.getMonth(),
                  selectedDate.getDate(),
                );
                return updated;
              });
            }
          }}
        />
      )}
      {Platform.OS === "android" && showScheduleModal && showTimePicker && (
        <DateTimePicker
          value={reminderDate}
          mode="time"
          onChange={(event, selectedTime) => {
            setShowTimePicker(false);
            if (event.type === "set" && selectedTime) {
              setReminderDate((current) => {
                const updated = new Date(current);
                updated.setHours(
                  selectedTime.getHours(),
                  selectedTime.getMinutes(),
                  0,
                  0,
                );
                return updated;
              });
            }
          }}
        />
      )}
      <View style={themeStyles.footer}>
        <Text style={themeStyles.footerText}>MATRIX · SIMPLE BY DESIGN</Text>
      </View>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#171C1E" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    justifyContent: "center",
    padding: 18,
  },
  scheduleModal: {
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    backgroundColor: "#252D30",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#354145",
    padding: 20,
  },
  modalTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginBottom: 7,
  },
  modalSubtitle: {
    color: "#A7B8B6",
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 18,
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 8 },
  modalSecondaryButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#3B484B",
    backgroundColor: "#171C1E",
  },
  modalPrimaryButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#48D6C1",
    backgroundColor: "#167E73",
  },
  modalSecondaryText: { color: "#A7B8B6", fontSize: 11, fontWeight: "800" },
  modalPrimaryText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  menuOverlay: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "rgba(0, 0, 0, 0.65)",
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  sideMenu: {
    width: "82%",
    maxWidth: 330,
    height: "100%",
    backgroundColor: "#1D2426",
    borderRightWidth: 1,
    borderRightColor: "#354145",
    paddingHorizontal: 18,
    paddingTop: 22,
    paddingBottom: 24,
  },
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingBottom: 24,
    marginBottom: 22,
    borderBottomWidth: 1,
    borderBottomColor: "#354145",
  },
  menuLogo: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#263D3B",
    borderWidth: 1,
    borderColor: "#48D6C1",
    alignItems: "center",
    justifyContent: "center",
  },
  menuBrand: { flex: 1 },
  menuSubtitle: { color: "#90A3A1", fontSize: 12, marginTop: 3 },
  menuCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#252D30",
  },
  menuCloseText: { color: "#B6C7C5", fontSize: 25, lineHeight: 28 },
  menuSectionLabel: {
    color: "#70817F",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.5,
    marginBottom: 10,
    marginTop: 8,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 15,
    borderRadius: 10,
    marginBottom: 5,
  },
  menuItemActive: {
    backgroundColor: "#263D3B",
    borderWidth: 1,
    borderColor: "#365C56",
  },
  menuItemIcon: { color: "#48D6C1", width: 22, textAlign: "center", fontSize: 19 },
  menuItemText: { flex: 1, color: "#B6C7C5", fontSize: 14, fontWeight: "600" },
  menuItemTextActive: { color: "#B8F5EB", fontWeight: "800" },
  menuDivider: {
    height: 1,
    backgroundColor: "#354145",
    marginVertical: 20,
  },
  menuFooter: {
    marginTop: "auto",
    borderTopWidth: 1,
    borderTopColor: "#354145",
    paddingTop: 18,
  },
  menuFooterText: { color: "#48D6C1", fontSize: 10, fontWeight: "800", letterSpacing: 2 },
  menuFooterSubtext: { color: "#70817F", fontSize: 11, marginTop: 5 },
  settingsPlaceholder: { flex: 1 },
  settingsCard: {
    alignItems: "stretch",
    backgroundColor: "#252D30",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#354145",
    padding: 18,
    marginTop: 12,
    marginBottom: 18,
  },
  settingsIcon: { color: "#48D6C1", fontSize: 34, marginBottom: 12 },
  settingsTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "800", marginBottom: 5 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#354145",
    gap: 12,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: "#263D3B",
    borderWidth: 1,
    borderColor: "#48D6C1",
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { color: "#48D6C1", fontSize: 25, fontWeight: "800" },
  homeLogo: { marginLeft: 0 },
  homeLogoActive: { backgroundColor: "#263D3B", borderColor: "#48D6C1" },
  homeLogoText: { color: "#48D6C1", fontSize: 31, lineHeight: 36, fontWeight: "700", marginTop: -3 },
  brandText: { flex: 1 },
  homeScreen: { flex: 1 },
  homeDateBlock: { marginBottom: 28, paddingBottom: 22, borderBottomWidth: 1, borderBottomColor: "#354145" },
  homeEyebrow: { color: "#48D6C1", fontSize: 11, fontWeight: "800", letterSpacing: 2, marginBottom: 8 },
  homeDate: { color: "#9FB3B2", fontSize: 16, marginTop: 5 },
  homeSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 },
  homeSectionActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  homeTextButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, borderWidth: 1, borderColor: "#365C56", backgroundColor: "#263D3B", alignSelf: "flex-start", marginTop: 10 },
  homeTextButtonText: { color: "#48D6C1", fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  homeAlarmHeader: { marginTop: 28 },
  homeAlarmRow: { flexDirection: "row", alignItems: "center", gap: 13, padding: 15, marginBottom: 10, borderRadius: 14, borderWidth: 1, borderColor: "#354145", backgroundColor: "#252D30" },
  homeAlarmIcon: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#263D3B", borderWidth: 1, borderColor: "#365C56" },
  homeAlarmIconText: { color: "#48D6C1", fontSize: 23, fontWeight: "700" },
  homeAlarmCopy: { flex: 1 },
  homeAlarmTime: { color: "#FFFFFF", fontSize: 23, fontWeight: "800", fontVariant: ["tabular-nums"] },
  homeAlarmArrow: { color: "#48D6C1", fontSize: 27, fontWeight: "300" },
  appName: {
    color: "#FFFFFF",
    fontSize: 19,
    fontWeight: "800",
    letterSpacing: 3,
  },
  tagline: { color: "#9FB3B2", fontSize: 12, marginTop: 3 },
  headerSectionButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#354145",
    backgroundColor: "#252D30",
  },
  headerSectionButtonActive: {
    backgroundColor: "#263D3B",
    borderColor: "#48D6C1",
  },
  headerSectionButtonText: {
    color: "#A7B8B6",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.7,
  },
  headerSectionButtonTextActive: { color: "#48D6C1" },
  list: { flex: 1 },
  content: { paddingHorizontal: 22, paddingTop: 26, paddingBottom: 44 },
  heading: { color: "#FFFFFF", fontSize: 30, fontWeight: "800" },
  pageTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 20,
  },
  backButton: {
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#354145",
    backgroundColor: "#252D30",
  },
  backButtonText: {
    color: "#A7B8B6",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  taskListButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 18,
    paddingVertical: 15,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#48D6C1",
    backgroundColor: "#263D3B",
  },
  taskListButtonText: {
    color: "#B8F5EB",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  taskListButtonCount: {
    color: "#171C1E",
    backgroundColor: "#48D6C1",
    overflow: "hidden",
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "800",
  },
  description: {
    color: "#B6C7C5",
    fontSize: 14,
    marginTop: 7,
    marginBottom: 20,
  },
  viewTabs: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 23,
    padding: 5,
    backgroundColor: "#252D30",
    borderRadius: 12,
  },
  viewTab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    borderRadius: 9,
  },
  viewTabActive: { backgroundColor: "#263D3B" },
  viewTabText: { color: "#A7B8B6", fontSize: 11, fontWeight: "700" },
  viewTabTextActive: { color: "#B8F5EB" },
  label: {
    color: "#48D6C1",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.3,
    marginBottom: 10,
  },
  form: {
    backgroundColor: "#252D30",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#354145",
    padding: 18,
    marginTop: 8,
  },
  formTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 1.5,
    marginBottom: 20,
  },
  input: {
    backgroundColor: "#171C1E",
    borderWidth: 1,
    borderColor: "#3B484B",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: "#FFFFFF",
    fontSize: 14,
    marginBottom: 21,
  },
  multilineInput: { minHeight: 88, lineHeight: 20 },
  noteBodyInput: { minHeight: 140, lineHeight: 21 },
  noteSearch: { marginTop: 18, marginBottom: 8 },
  dateRow: { flexDirection: "row", gap: 10, marginBottom: 22 },
  dateButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    padding: 11,
    backgroundColor: "#171C1E",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#3B484B",
  },
  dateIcon: { color: "#48D6C1", fontSize: 22 },
  dateCaption: {
    color: "#90A3A1",
    fontSize: 9,
    fontWeight: "700",
    marginBottom: 4,
  },
  dateValue: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
  recurrenceRow: { flexDirection: "row", gap: 7, marginBottom: 9 },
  recurrenceButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#3B484B",
    backgroundColor: "#171C1E",
  },
  recurrenceButtonActive: {
    backgroundColor: "#263D3B",
    borderColor: "#48D6C1",
  },
  recurrenceText: { color: "#A7B8B6", fontSize: 11, fontWeight: "700" },
  recurrenceTextActive: { color: "#B8F5EB" },
  repeatHint: {
    color: "#90A3A1",
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 18,
  },
  addButton: {
    backgroundColor: "#167E73",
    borderColor: "#48D6C1",
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.55 },
  addButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  cancelEditButton: { alignSelf: "center", padding: 12 },
  cancelEditText: {
    color: "#9FB3B2",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
  tasksHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 30,
    marginBottom: 14,
  },
  sectionTitle: {
    color: "#B6C7C5",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.8,
  },
  count: {
    overflow: "hidden",
    color: "#48D6C1",
    backgroundColor: "#263D3B",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: "700",
  },
  taskCard: {
    backgroundColor: "#252D30",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#354145",
    padding: 14,
    marginBottom: 10,
  },
  taskTopRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  checkbox: {
    width: 23,
    height: 23,
    borderWidth: 1.5,
    borderColor: "#71817F",
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: "#167E73", borderColor: "#48D6C1" },
  checkboxText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  taskMain: { flex: 1 },
  taskTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  completedTitle: { color: "#90A3A1", textDecorationLine: "line-through" },
  taskDate: { color: "#B6C7C5", fontSize: 11, marginTop: 6 },
  overdueText: { color: "#FF8980", fontWeight: "800" },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 },
  repeatBadge: { color: "#48D6C1", fontSize: 10, fontWeight: "700" },
  subtaskBadge: { color: "#B8F5EB", fontSize: 10, fontWeight: "700" },
  starButton: { paddingHorizontal: 2, paddingVertical: 5 },
  starText: { color: "#70817F", fontSize: 24 },
  starredText: { color: "#D9B56D" },
  deleteButton: { paddingHorizontal: 3, paddingVertical: 3 },
  deleteText: { color: "#A7B8B6", fontSize: 25 },
  subtaskArea: {
    borderTopWidth: 1,
    borderTopColor: "#354145",
    marginTop: 13,
    paddingTop: 12,
    marginLeft: 32,
  },
  subtaskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  smallCheckbox: {
    width: 18,
    height: 18,
    borderWidth: 1.3,
    borderColor: "#71817F",
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  subtaskTitle: { color: "#D4E0DE", fontSize: 12, flex: 1 },
  addSubtaskRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  subtaskInput: {
    flex: 1,
    backgroundColor: "#171C1E",
    borderWidth: 1,
    borderColor: "#3B484B",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: "#FFFFFF",
    fontSize: 12,
  },
  smallAddButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: "#263D3B",
    borderWidth: 1,
    borderColor: "#48D6C1",
  },
  smallAddText: { color: "#48D6C1", fontSize: 20, fontWeight: "700" },
  noteCard: {
    backgroundColor: "#252D30",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#354145",
    padding: 15,
    marginBottom: 10,
  },
  noteHeader: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30 },
  noteExpandIcon: { color: "#48D6C1", fontSize: 22, fontWeight: "700", paddingHorizontal: 4 },
  noteExpandedHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 5 },
  noteTitle: { flex: 1, color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  noteBody: { color: "#D4E0DE", fontSize: 13, lineHeight: 20, marginTop: 10 },
  noteDate: {
    color: "#90A3A1",
    fontSize: 10,
    marginTop: 12,
    letterSpacing: 0.6,
  },
  noteIconButton: { paddingHorizontal: 5, paddingVertical: 3 },
  notePinText: { color: "#D9B56D", fontSize: 22 },
  noteActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#354145",
    paddingTop: 10,
  },
  noteActionButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 7,
    backgroundColor: "#263D3B",
  },
  noteActionText: {
    color: "#48D6C1",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
  noteDeleteText: {
    color: "#E69A91",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
  emptyCard: {
    alignItems: "center",
    backgroundColor: "#252D30",
    borderRadius: 14,
    padding: 25,
    borderWidth: 1,
    borderColor: "#354145",
    borderStyle: "dashed",
  },
  emptyIcon: { color: "#48D6C1", fontSize: 30, marginBottom: 10 },
  emptyTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  emptyText: {
    color: "#B6C7C5",
    fontSize: 12,
    textAlign: "center",
    lineHeight: 19,
    marginTop: 7,
  },
  bottomNote: {
    color: "#70817F",
    fontSize: 10,
    textAlign: "center",
    marginTop: 25,
    marginBottom: 10,
  },
  settingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 7 },
  settingCopy: { flex: 1, gap: 4 },
  settingsHelp: { color: "#90A3A1", fontSize: 12, lineHeight: 17, marginTop: 4 },
  settingChoices: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12, marginBottom: 5 },
  settingChoice: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 9, borderWidth: 1, borderColor: "#354145", backgroundColor: "#171C1E" },
  settingChoiceActive: { borderColor: "#48D6C1", backgroundColor: "#263D3B" },
  settingChoiceText: { color: "#A7B8B6", fontSize: 12, fontWeight: "700" },
  settingChoiceTextActive: { color: "#48D6C1" },
  clockScreen: { gap: 14 },
  clockTabs: { flexDirection: "row", gap: 7, backgroundColor: "#1D2426", borderRadius: 12, padding: 5, borderWidth: 1, borderColor: "#354145" },
  clockTab: { flex: 1, paddingVertical: 12, alignItems: "center", borderRadius: 9 },
  clockTabActive: { backgroundColor: "#263D3B", borderWidth: 1, borderColor: "#365C56" },
  clockTabText: { color: "#A7B8B6", fontSize: 12, fontWeight: "700" },
  clockTabTextActive: { color: "#B8F5EB", fontWeight: "900" },
  clockCard: { backgroundColor: "#252D30", borderRadius: 16, borderWidth: 1, borderColor: "#354145", padding: 18, gap: 15 },
  clockTimePickerButton: { alignItems: "center", paddingVertical: 18, borderRadius: 12, backgroundColor: "#171C1E", borderWidth: 1, borderColor: "#354145" },
  clockBigTime: { color: "#FFFFFF", fontSize: 48, fontWeight: "300", fontVariant: ["tabular-nums"] },
  clockPrimaryButton: { alignItems: "center", justifyContent: "center", paddingVertical: 14, paddingHorizontal: 18, borderRadius: 10, backgroundColor: "#167E73", borderWidth: 1, borderColor: "#48D6C1", flex: 1 },
  clockPrimaryText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900", letterSpacing: 0.7 },
  clockSecondaryButton: { alignItems: "center", justifyContent: "center", paddingVertical: 14, paddingHorizontal: 18, borderRadius: 10, backgroundColor: "#171C1E", borderWidth: 1, borderColor: "#455155", flex: 1 },
  clockSecondaryText: { color: "#B6C7C5", fontSize: 11, fontWeight: "900", letterSpacing: 0.7 },
  alarmRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 11, backgroundColor: "#1D2426", borderWidth: 1, borderColor: "#354145" },
  alarmTimeArea: { flex: 1 },
  alarmTime: { color: "#FFFFFF", fontSize: 28, fontWeight: "400", fontVariant: ["tabular-nums"] },
  alarmDisabled: { color: "#70817F" },
  alarmDeleteButton: { paddingHorizontal: 8, paddingVertical: 4 },
  alarmDeleteText: { color: "#E69A91", fontSize: 25 },
  clockTimerDisplay: { color: "#FFFFFF", textAlign: "center", fontSize: 48, fontWeight: "300", fontVariant: ["tabular-nums"], paddingVertical: 20 },
  timerInputs: { flexDirection: "row", gap: 8 },
  timerInputGroup: { flex: 1 },
  timerInput: { backgroundColor: "#171C1E", borderWidth: 1, borderColor: "#3B484B", borderRadius: 10, paddingVertical: 12, textAlign: "center", color: "#FFFFFF", fontSize: 22, fontWeight: "700" },
  clockControls: { flexDirection: "row", gap: 10 },
  calendarScreen: { gap: 14 },
  calendarMonthHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  calendarMonthTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  calendarArrow: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#252D30", borderWidth: 1, borderColor: "#354145" },
  calendarArrowText: { color: "#48D6C1", fontSize: 27, lineHeight: 30 },
  calendarGrid: { flexDirection: "row", flexWrap: "wrap", borderWidth: 1, borderColor: "#354145", borderRadius: 14, padding: 7, backgroundColor: "#1D2426" },
  calendarWeekday: { width: "14.2857%", textAlign: "center", color: "#90A3A1", fontSize: 11, fontWeight: "800", paddingVertical: 9 },
  calendarDayCell: { width: "14.2857%", minHeight: 45, alignItems: "center", justifyContent: "center", borderRadius: 10, marginVertical: 1 },
  calendarDaySelected: { backgroundColor: "#167E73" },
  calendarDayToday: { borderWidth: 1, borderColor: "#48D6C1" },
  calendarDayText: { color: "#D4E0DE", fontSize: 13, fontWeight: "600" },
  calendarDayTextSelected: { color: "#FFFFFF", fontWeight: "900" },
  calendarDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#48D6C1", marginTop: 3 },
  calendarDotSelected: { backgroundColor: "#FFFFFF" },
  calendarSelectedHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 8 },
  calendarAddButton: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 9, backgroundColor: "#167E73", borderWidth: 1, borderColor: "#48D6C1" },
  calendarAddText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900", letterSpacing: 0.6 },
  calendarReminder: { flexDirection: "row", alignItems: "center", gap: 12, padding: 13, borderRadius: 11, borderWidth: 1, borderColor: "#354145", backgroundColor: "#252D30" },
  calendarReminderTime: { color: "#48D6C1", fontSize: 12, fontWeight: "800", minWidth: 62 },
  calendarReminderInfo: { flex: 1 },
  calendarReminderTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  footer: {
    paddingTop: 12,
    paddingBottom: 8,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#354145",
  },
  footerText: {
    color: "#70817F",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 2,
  },
});
