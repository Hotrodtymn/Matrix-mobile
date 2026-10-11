import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Notifications from "expo-notifications";

const STORAGE_KEY = "matrix.reminders.v1";
const LISTS_KEY = "matrix.lists.v1";
const NOTES_KEY = "matrix.notes.v1";
const NOTIFICATION_CATEGORY = "MATRIX_REMINDER";

type Recurrence = "once" | "daily" | "weekly" | "monthly";
type AppView = "today" | "all" | "starred" | "completed";

type Subtask = {
  id: string;
  title: string;
  completed: boolean;
};

type TaskList = {
  id: string;
  name: string;
};

type Reminder = {
  id: string;
  title: string;
  date: string;
  notificationId: string;
  recurrence?: Recurrence;
  completed?: boolean;
  starred?: boolean;
  listId?: string;
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

const DEFAULT_LISTS: TaskList[] = [
  { id: "personal", name: "Personal" },
  { id: "workouts", name: "Workouts" },
  { id: "home", name: "Home" },
];

const NOTIFICATION_ACTIONS: Notifications.NotificationAction[] = [
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

  const minutes = snoozeMinutes[action];
  if (!minutes) return;

  const originalTitle =
    typeof request.content.data?.title === "string"
      ? request.content.data.title
      : request.content.body || request.content.title || "Reminder";

  const reminderId =
    typeof request.content.data?.reminderId === "string"
      ? request.content.data.reminderId
      : undefined;

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

  // This only dismisses the currently displayed notification. It does not
  // cancel the task's original repeating schedule.
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
    default:
      return "One-time task";
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

  return {
    type: Notifications.SchedulableTriggerInputTypes.DATE,
    date,
    ...channel,
  } satisfies Notifications.NotificationTriggerInput;
}

export default function App() {
  const [title, setTitle] = useState("");
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [reminderDate, setReminderDate] = useState(
    new Date(Date.now() + 60 * 60 * 1000),
  );
  const [recurrence, setRecurrence] = useState<Recurrence>("once");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [lists, setLists] = useState<TaskList[]>(DEFAULT_LISTS);
  const [view, setView] = useState<AppView>("today");
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [newListName, setNewListName] = useState("");
  const [showNewListInput, setShowNewListInput] = useState(false);
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
  const [showNotes, setShowNotes] = useState(false);
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

        const [storedReminders, storedLists, storedNotes] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          AsyncStorage.getItem(LISTS_KEY),
          AsyncStorage.getItem(NOTES_KEY),
        ]);

        if (storedReminders) {
          const parsed = JSON.parse(storedReminders) as Reminder[];

          setReminders(
            parsed.map((reminder) => ({
              ...reminder,
              completed: reminder.completed ?? false,
              starred: reminder.starred ?? false,
              listId: reminder.listId ?? DEFAULT_LISTS[0].id,
              subtasks: reminder.subtasks ?? [],
            })),
          );
        }

        if (storedLists) {
          const parsedLists = JSON.parse(storedLists) as TaskList[];
          setLists(parsedLists.length ? parsedLists : DEFAULT_LISTS);
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
        void handleNotificationResponse(response).catch((error) => {
          console.error("Could not process notification action:", error);
        });
      });

    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          return handleNotificationResponse(response);
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
    const timer = setInterval(() => setNow(Date.now()), 30000);

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });

    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  async function saveReminders(updated: Reminder[]) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setReminders(updated);
  }

  async function saveLists(updated: TaskList[]) {
    await AsyncStorage.setItem(LISTS_KEY, JSON.stringify(updated));
    setLists(updated);
  }

  async function saveNotes(updated: Note[]) {
    await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(updated));
    setNotes(updated);
  }

  async function addReminder() {
    const cleanTitle = title.trim();

    if (!cleanTitle) {
      Alert.alert("Add a task", "Enter what you need to do.");
      return;
    }

    if (reminderDate.getTime() <= Date.now()) {
      Alert.alert(
        "Choose a future time",
        "Your reminder must be scheduled in the future.",
      );
      return;
    }

    setSaving(true);
    let notificationId: string | undefined;

    try {
      const permission = await Notifications.getPermissionsAsync();
      let granted = permission.granted;

      if (!granted) {
        granted = (await Notifications.requestPermissionsAsync()).granted;
      }

      if (!granted) {
        Alert.alert(
          "Notifications are disabled",
          "Allow Matrix to send notifications in Android settings.",
        );
        return;
      }

      const taskId = `${Date.now()}-${Math.random()}`;
      const chosenListId = selectedListId ?? lists[0]?.id ?? "personal";

      notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Matrix Reminder",
          body: cleanTitle,
          sound: "default",
          categoryIdentifier: NOTIFICATION_CATEGORY,
          data: { reminderId: taskId, title: cleanTitle },
        },
        trigger: buildTrigger(reminderDate, recurrence),
      });

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
        listId: chosenListId,
        subtasks,
      };

      await saveReminders([newReminder, ...reminders]);

      setTitle("");
      setSubtaskDraft("");
      setRecurrence("once");
      setReminderDate(new Date(Date.now() + 60 * 60 * 1000));
      setNow(Date.now());

      Alert.alert("Task created", "Your task has been saved.");
    } catch (error) {
      console.error("Could not create task:", error);

      if (notificationId) {
        await Notifications.cancelScheduledNotificationAsync(
          notificationId,
        ).catch(() => undefined);
      }

      Alert.alert("Couldn't save task", "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteReminder(reminder: Reminder) {
    Alert.alert("Delete task?", `Permanently remove "${reminder.title}"?`, [
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
              Alert.alert("Couldn't delete task", "Please try again.");
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
      Alert.alert("Couldn't update task", "Please try again.");
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
        "Couldn't complete task",
        "Matrix couldn't save this change. Please try again.",
      );
    }
  }

  async function restoreReminder(reminder: Reminder) {
    try {
      if (getRecurrence(reminder) === "once") {
        const nextDate = new Date(reminder.date);
        let notificationId = reminder.notificationId;

        if (nextDate.getTime() > Date.now()) {
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
            "Task restored",
            "This task is overdue. Reschedule it to receive another notification.",
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
      Alert.alert("Couldn't restore task", "Please try again.");
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
  }

  async function addList() {
    const name = newListName.trim();

    if (!name) {
      Alert.alert("Name your list", "Enter a name for your new list.");
      return;
    }

    if (lists.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      Alert.alert("List already exists", "Choose a different list name.");
      return;
    }

    const list = { id: `list-${Date.now()}`, name };

    try {
      await saveLists([...lists, list]);
      setSelectedListId(list.id);
      setNewListName("");
      setShowNewListInput(false);
      setView("all");
    } catch (error) {
      console.error("Could not create list:", error);
      Alert.alert("Couldn't create list", "Please try again.");
    }
  }

  function clearNoteEditor() {
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
        if (selectedListId && item.listId !== selectedListId) return false;

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
  }, [reminders, selectedListId, view, now]);

  const viewTitle: Record<AppView, string> = {
    today: "Today",
    all: "All tasks",
    starred: "Starred",
    completed: "Completed",
  };

  function renderReminder(reminder: Reminder) {
    const completed = !!reminder.completed;
    const taskDate = getTaskDate(reminder, new Date(now));
    const overdue =
      !completed &&
      getRecurrence(reminder) === "once" &&
      new Date(reminder.date).getTime() < now;

    const children = reminder.subtasks ?? [];
    const completedChildren = children.filter(
      (child) => child.completed,
    ).length;
    const expanded = expandedTasks.includes(reminder.id);
    const taskList = lists.find((item) => item.id === reminder.listId);

    return (
      <View key={reminder.id} style={styles.taskCard}>
        <View style={styles.taskTopRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              completed
                ? `Restore ${reminder.title}`
                : `Complete ${reminder.title}`
            }
            style={[styles.checkbox, completed && styles.checkboxChecked]}
            onPress={() => {
              if (completed) void restoreReminder(reminder);
              else void completeReminder(reminder);
            }}
          >
            <Text style={styles.checkboxText}>{completed ? "✓" : ""}</Text>
          </Pressable>

          <Pressable
            style={styles.taskMain}
            onPress={() =>
              setExpandedTasks((current) =>
                current.includes(reminder.id)
                  ? current.filter((id) => id !== reminder.id)
                  : [...current, reminder.id],
              )
            }
          >
            <Text
              style={[styles.taskTitle, completed && styles.completedTitle]}
            >
              {reminder.title}
            </Text>

            <Text style={[styles.taskDate, overdue && styles.overdueText]}>
              {overdue ? "OVERDUE · " : ""}
              {formatDate(taskDate)} · {formatTime(taskDate)}
            </Text>

            <View style={styles.badgeRow}>
              {taskList && (
                <Text style={styles.listBadge}>{taskList.name}</Text>
              )}

              {getRecurrence(reminder) !== "once" && (
                <Text style={styles.repeatBadge}>
                  {recurrenceLabel(reminder.recurrence)}
                </Text>
              )}

              {children.length > 0 && (
                <Text style={styles.subtaskBadge}>
                  {completedChildren}/{children.length} steps
                </Text>
              )}
            </View>
          </Pressable>

          <Pressable
            style={styles.starButton}
            accessibilityRole="button"
            accessibilityLabel={reminder.starred ? "Remove star" : "Star task"}
            onPress={() => void toggleStar(reminder)}
          >
            <Text
              style={[styles.starText, reminder.starred && styles.starredText]}
            >
              {reminder.starred ? "★" : "☆"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.deleteButton}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${reminder.title}`}
            onPress={() => void deleteReminder(reminder)}
          >
            <Text style={styles.deleteText}>×</Text>
          </Pressable>
        </View>

        {expanded && (
          <View style={styles.subtaskArea}>
            {children.map((child) => (
              <Pressable
                key={child.id}
                style={styles.subtaskRow}
                onPress={() => void toggleSubtask(reminder, child)}
              >
                <View
                  style={[
                    styles.smallCheckbox,
                    child.completed && styles.checkboxChecked,
                  ]}
                >
                  <Text style={styles.checkboxText}>
                    {child.completed ? "✓" : ""}
                  </Text>
                </View>

                <Text
                  style={[
                    styles.subtaskTitle,
                    child.completed && styles.completedTitle,
                  ]}
                >
                  {child.title}
                </Text>
              </Pressable>
            ))}

            <View style={styles.addSubtaskRow}>
              <TextInput
                style={styles.subtaskInput}
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
                style={styles.smallAddButton}
                onPress={() => void addSubtask(reminder)}
              >
                <Text style={styles.smallAddText}>+</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    );
  }

  function renderNote(note: Note) {
    return (
      <View key={note.id} style={styles.noteCard}>
        <View style={styles.noteHeader}>
          <Text style={styles.noteTitle} numberOfLines={2}>
            {note.title}
          </Text>

          <Pressable
            style={styles.noteIconButton}
            accessibilityRole="button"
            accessibilityLabel={note.pinned ? "Unpin note" : "Pin note"}
            onPress={() => void toggleNotePin(note)}
          >
            <Text style={styles.notePinText}>{note.pinned ? "★" : "☆"}</Text>
          </Pressable>
        </View>

        {note.body.length > 0 && (
          <Text style={styles.noteBody}>{note.body}</Text>
        )}

        <Text style={styles.noteDate}>
          UPDATED {formatDate(note.updatedAt)}
        </Text>

        <View style={styles.noteActions}>
          <Pressable
            style={styles.noteActionButton}
            onPress={() => editNote(note)}
          >
            <Text style={styles.noteActionText}>EDIT</Text>
          </Pressable>

          <Pressable
            style={styles.noteActionButton}
            onPress={() => void toggleNotePin(note)}
          >
            <Text style={styles.noteActionText}>
              {note.pinned ? "UNPIN" : "PIN"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.noteActionButton}
            onPress={() => deleteNote(note)}
          >
            <Text style={styles.noteDeleteText}>DELETE</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <StatusBar barStyle="light-content" backgroundColor="#171C1E" />

      <View style={styles.header}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>M</Text>
        </View>

        <View style={styles.brandText}>
          <Text style={styles.appName}>MATRIX</Text>
          <Text style={styles.tagline}>Your time. Your priorities.</Text>
        </View>

        <Pressable
          style={[
            styles.headerSectionButton,
            showNotes && styles.headerSectionButtonActive,
          ]}
          onPress={() => setShowNotes((value) => !value)}
        >
          <Text
            style={[
              styles.headerSectionButtonText,
              showNotes && styles.headerSectionButtonTextActive,
            ]}
          >
            {showNotes
              ? "TASKS"
              : `NOTES${notes.length ? ` · ${notes.length}` : ""}`}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {showNotes ? (
          <>
            <Text style={styles.heading}>Your notes</Text>
            <Text style={styles.description}>
              Keep your ideas, plans, and important details in one place.
            </Text>

            <View style={styles.form}>
              <Text style={styles.formTitle}>
                {editingNoteId ? "EDIT NOTE" : "CREATE A NOTE"}
              </Text>

              <Text style={styles.label}>TITLE</Text>
              <TextInput
                style={styles.input}
                value={noteTitle}
                onChangeText={setNoteTitle}
                placeholder="Give your note a title"
                placeholderTextColor="#70817F"
                maxLength={120}
              />

              <Text style={styles.label}>NOTE</Text>
              <TextInput
                style={[styles.input, styles.noteBodyInput]}
                value={noteBody}
                onChangeText={setNoteBody}
                placeholder="Write down your thoughts..."
                placeholderTextColor="#70817F"
                multiline
                textAlignVertical="top"
                maxLength={10000}
              />

              <Pressable
                style={[styles.addButton, savingNote && styles.buttonDisabled]}
                disabled={savingNote}
                onPress={() => void saveNote()}
              >
                <Text style={styles.addButtonText}>
                  {savingNote
                    ? "SAVING..."
                    : editingNoteId
                      ? "SAVE CHANGES"
                      : "+  SAVE NOTE"}
                </Text>
              </Pressable>

              {editingNoteId && (
                <Pressable
                  style={styles.cancelEditButton}
                  onPress={clearNoteEditor}
                >
                  <Text style={styles.cancelEditText}>CANCEL EDITING</Text>
                </Pressable>
              )}
            </View>

            <TextInput
              style={[styles.input, styles.noteSearch]}
              value={noteSearch}
              onChangeText={setNoteSearch}
              placeholder="Search your notes..."
              placeholderTextColor="#70817F"
              clearButtonMode="while-editing"
            />

            <View style={styles.tasksHeadingRow}>
              <Text style={styles.sectionTitle}>SAVED NOTES</Text>
              <Text style={styles.count}>{visibleNotes.length}</Text>
            </View>

            {visibleNotes.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyIcon}>✎</Text>
                <Text style={styles.emptyTitle}>
                  {noteSearch.trim() ? "No matching notes" : "No notes yet"}
                </Text>
                <Text style={styles.emptyText}>
                  {noteSearch.trim()
                    ? "Try a different search."
                    : "Create a note above to save an idea or plan."}
                </Text>
              </View>
            ) : (
              visibleNotes.map(renderNote)
            )}

            <Text style={styles.bottomNote}>
              NOTES STAY ON THIS DEVICE · MATRIX
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.heading}>Your tasks</Text>
            <Text style={styles.description}>Make time for what matters.</Text>

            <View style={styles.viewTabs}>
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
                  style={[styles.viewTab, view === key && styles.viewTabActive]}
                >
                  <Text
                    style={[
                      styles.viewTabText,
                      view === key && styles.viewTabTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>YOUR LISTS</Text>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.listChips}
            >
              <Pressable
                onPress={() => setSelectedListId(null)}
                style={[
                  styles.listChip,
                  selectedListId === null && styles.listChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.listChipText,
                    selectedListId === null && styles.listChipTextActive,
                  ]}
                >
                  All lists
                </Text>
              </Pressable>

              {lists.map((list) => (
                <Pressable
                  key={list.id}
                  onPress={() => setSelectedListId(list.id)}
                  style={[
                    styles.listChip,
                    selectedListId === list.id && styles.listChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.listChipText,
                      selectedListId === list.id && styles.listChipTextActive,
                    ]}
                  >
                    {list.name}
                  </Text>
                </Pressable>
              ))}

              <Pressable
                onPress={() => setShowNewListInput((value) => !value)}
                style={styles.addListChip}
              >
                <Text style={styles.addListChipText}>+ New list</Text>
              </Pressable>
            </ScrollView>

            {showNewListInput && (
              <View style={styles.newListRow}>
                <TextInput
                  style={[styles.input, styles.newListInput]}
                  value={newListName}
                  onChangeText={setNewListName}
                  placeholder="List name"
                  placeholderTextColor="#70817F"
                  maxLength={35}
                  returnKeyType="done"
                  onSubmitEditing={() => void addList()}
                />

                <Pressable
                  style={styles.smallAddButton}
                  onPress={() => void addList()}
                >
                  <Text style={styles.smallAddText}>✓</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.form}>
              <Text style={styles.formTitle}>CREATE A TASK</Text>

              <Text style={styles.label}>WHAT DO YOU NEED TO DO?</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Leg day workout"
                placeholderTextColor="#70817F"
                returnKeyType="next"
                maxLength={150}
              />

              <Text style={styles.label}>ADD CHECKLIST STEPS (OPTIONAL)</Text>
              <TextInput
                style={[styles.input, styles.multilineInput]}
                value={subtaskDraft}
                onChangeText={setSubtaskDraft}
                placeholder={
                  "One step per line\nHack squat\nLeg curls\nCalf raises"
                }
                placeholderTextColor="#70817F"
                multiline
                textAlignVertical="top"
                maxLength={1200}
              />

              <Text style={styles.label}>SAVE TO LIST</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.listChips}
              >
                {lists.map((list) => (
                  <Pressable
                    key={list.id}
                    onPress={() => setSelectedListId(list.id)}
                    style={[
                      styles.listChip,
                      (selectedListId ?? lists[0]?.id) === list.id &&
                        styles.listChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.listChipText,
                        (selectedListId ?? lists[0]?.id) === list.id &&
                          styles.listChipTextActive,
                      ]}
                    >
                      {list.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Text style={styles.label}>WHEN SHOULD WE REMIND YOU?</Text>
              <View style={styles.dateRow}>
                <Pressable
                  style={styles.dateButton}
                  onPress={() => {
                    setShowTimePicker(false);
                    setShowDatePicker(true);
                  }}
                >
                  <Text style={styles.dateIcon}>▦</Text>
                  <View>
                    <Text style={styles.dateCaption}>DATE</Text>
                    <Text style={styles.dateValue}>
                      {formatDate(reminderDate)}
                    </Text>
                  </View>
                </Pressable>

                <Pressable
                  style={styles.dateButton}
                  onPress={() => {
                    setShowDatePicker(false);
                    setShowTimePicker(true);
                  }}
                >
                  <Text style={styles.dateIcon}>◷</Text>
                  <View>
                    <Text style={styles.dateCaption}>TIME</Text>
                    <Text style={styles.dateValue}>
                      {formatTime(reminderDate)}
                    </Text>
                  </View>
                </Pressable>
              </View>

              {showDatePicker && (
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

              {showTimePicker && (
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

              <Text style={styles.label}>REPEAT</Text>
              <View style={styles.recurrenceRow}>
                {(["once", "daily", "weekly", "monthly"] as Recurrence[]).map(
                  (option) => (
                    <Pressable
                      key={option}
                      onPress={() => setRecurrence(option)}
                      style={[
                        styles.recurrenceButton,
                        recurrence === option && styles.recurrenceButtonActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.recurrenceText,
                          recurrence === option && styles.recurrenceTextActive,
                        ]}
                      >
                        {option === "once"
                          ? "Once"
                          : option[0].toUpperCase() + option.slice(1)}
                      </Text>
                    </Pressable>
                  ),
                )}
              </View>

              <Text style={styles.repeatHint}>
                {recurrence === "once"
                  ? "Send one notification at the selected time."
                  : recurrence === "daily"
                    ? "Repeat every day at the selected time."
                    : recurrence === "weekly"
                      ? `Repeat every ${reminderDate.toLocaleDateString([], {
                          weekday: "long",
                        })}.`
                      : `Repeat on day ${reminderDate.getDate()} of each month.`}
              </Text>

              <Pressable
                style={[
                  styles.addButton,
                  (saving || loading) && styles.buttonDisabled,
                ]}
                onPress={() => void addReminder()}
                disabled={saving || loading}
              >
                <Text style={styles.addButtonText}>
                  {saving ? "SAVING..." : "+  CREATE TASK"}
                </Text>
              </Pressable>
            </View>

            <View style={styles.tasksHeadingRow}>
              <Text style={styles.sectionTitle}>
                {viewTitle[view].toUpperCase()}
              </Text>
              <Text style={styles.count}>{visibleReminders.length}</Text>
            </View>

            {loading ? (
              <Text style={styles.emptyText}>Loading your tasks...</Text>
            ) : visibleReminders.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyIcon}>
                  {view === "completed" ? "✓" : view === "starred" ? "☆" : "◷"}
                </Text>

                <Text style={styles.emptyTitle}>
                  {view === "completed"
                    ? "No completed tasks yet"
                    : view === "starred"
                      ? "No starred tasks"
                      : view === "today"
                        ? "You're all caught up"
                        : "No tasks in this view"}
                </Text>

                <Text style={styles.emptyText}>
                  {view === "today"
                    ? "Tasks due today and overdue tasks will appear here."
                    : "Create a task above to get started."}
                </Text>
              </View>
            ) : (
              visibleReminders.map(renderReminder)
            )}

            <Text style={styles.bottomNote}>
              Tasks stay on this device. MATRIX · SIMPLE BY DESIGN
            </Text>
          </>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.footerText}>MATRIX · SIMPLE BY DESIGN</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#171C1E" },

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
  brandText: { flex: 1 },
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
  content: { paddingHorizontal: 22, paddingTop: 26, paddingBottom: 24 },
  heading: { color: "#FFFFFF", fontSize: 30, fontWeight: "800" },
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
  listChips: { flexDirection: "row", gap: 8, paddingBottom: 12 },
  listChip: {
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 18,
    backgroundColor: "#252D30",
    borderWidth: 1,
    borderColor: "#3B484B",
  },
  listChipActive: { backgroundColor: "#263D3B", borderColor: "#48D6C1" },
  listChipText: { color: "#A7B8B6", fontSize: 11, fontWeight: "700" },
  listChipTextActive: { color: "#B8F5EB" },
  addListChip: {
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#48D6C1",
  },
  addListChipText: { color: "#48D6C1", fontSize: 11, fontWeight: "700" },
  newListRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  newListInput: { flex: 1, marginBottom: 12 },

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
  listBadge: {
    color: "#B8F5EB",
    fontSize: 10,
    backgroundColor: "#263D3B",
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: "hidden",
  },
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
  noteHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
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
  footer: {
    paddingVertical: 12,
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
