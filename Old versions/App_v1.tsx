import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  Platform,
  Pressable,
  SafeAreaView,
  SectionList,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Notifications from "expo-notifications";

const STORAGE_KEY = "matrix.reminders.v1";
const NOTIFICATION_CATEGORY = "MATRIX_REMINDER";

const NOTIFICATION_ACTIONS = {
  COMPLETE: "COMPLETE_REMINDER",
  SNOOZE_15: "SNOOZE_15_MINUTES",
  SNOOZE_OPTIONS: "SNOOZE_OPTIONS",
};

type Recurrence = "once" | "daily" | "weekly" | "monthly";

type Reminder = {
  id: string;
  title: string;
  date: string;
  notificationId: string;
  recurrence?: Recurrence;
  snoozedNotificationIds?: string[];
};

type ReminderSection = {
  title: string;
  data: Reminder[];
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerNotificationActions() {
  await Notifications.setNotificationCategoryAsync(NOTIFICATION_CATEGORY, [
    {
      identifier: NOTIFICATION_ACTIONS.COMPLETE,
      buttonTitle: "Complete",
      options: { opensAppToForeground: false },
    },
    {
      identifier: NOTIFICATION_ACTIONS.SNOOZE_15,
      buttonTitle: "Snooze 15 min",
      options: { opensAppToForeground: false },
    },
    {
      identifier: NOTIFICATION_ACTIONS.SNOOZE_OPTIONS,
      buttonTitle: "Snooze options",
      options: { opensAppToForeground: true },
    },
  ]);
}

function getRecurrence(reminder: Reminder): Recurrence {
  return reminder.recurrence ?? "once";
}

function nextOccurrence(reminder: Reminder, from = new Date()): Date {
  const base = new Date(reminder.date);
  const result = new Date(base);
  const recurrence = getRecurrence(reminder);

  if (recurrence === "once") {
    return result;
  }

  result.setSeconds(0, 0);

  if (recurrence === "daily") {
    result.setFullYear(from.getFullYear(), from.getMonth(), from.getDate());

    if (result.getTime() <= from.getTime()) {
      result.setDate(result.getDate() + 1);
    }

    return result;
  }

  if (recurrence === "weekly") {
    const targetDay = base.getDay();

    result.setFullYear(from.getFullYear(), from.getMonth(), from.getDate());

    const daysAhead = (targetDay - result.getDay() + 7) % 7;
    result.setDate(result.getDate() + daysAhead);

    if (result.getTime() <= from.getTime()) {
      result.setDate(result.getDate() + 7);
    }

    return result;
  }

  const targetDay = base.getDate();

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

function recurrenceLabel(recurrence: Recurrence | undefined): string {
  switch (recurrence ?? "once") {
    case "daily":
      return "Repeats daily";
    case "weekly":
      return "Repeats weekly";
    case "monthly":
      return "Repeats monthly";
    default:
      return "One-time reminder";
  }
}

function getSnoozeDate(minutes: number): Date {
  const date = new Date();

  if (minutes === -1) {
    date.setDate(date.getDate() + 1);
  } else {
    date.setMinutes(date.getMinutes() + minutes);
  }

  date.setSeconds(0, 0);
  return date;
}

function getNotificationChannel() {
  return Platform.OS === "android" ? { channelId: "reminders" } : {};
}

export default function App() {
  const [title, setTitle] = useState("");
  const [reminderDate, setReminderDate] = useState(
    new Date(Date.now() + 60 * 60 * 1000),
  );
  const [recurrence, setRecurrence] = useState<Recurrence>("once");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());

  const remindersRef = useRef<Reminder[]>([]);
  const lastResponseKeyRef = useRef<string | null>(null);

  const saveReminders = useCallback(async (updated: Reminder[]) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    remindersRef.current = updated;
    setReminders(updated);
  }, []);

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

        await registerNotificationActions();

        const stored = await AsyncStorage.getItem(STORAGE_KEY);

        if (stored) {
          const parsed = JSON.parse(stored) as Reminder[];
          remindersRef.current = parsed;
          setReminders(parsed);
        }
      } catch (error) {
        console.error("Could not initialize Matrix:", error);
        Alert.alert(
          "Loading problem",
          "Matrix could not load your saved reminders or notification settings.",
        );
      } finally {
        setLoading(false);
      }
    }

    void initialize();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNow(Date.now());
      }
    });

    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  const snoozeReminder = useCallback(
    async (reminder: Reminder, minutes: number) => {
      try {
        const current = remindersRef.current.find(
          (item) => item.id === reminder.id,
        );

        if (!current) {
          Alert.alert(
            "Reminder unavailable",
            "This reminder may have already been deleted.",
          );
          return;
        }

        const existingSnoozes = current.snoozedNotificationIds ?? [];

        // Cancel older snoozes for this reminder before creating a new one.
        await Promise.all(
          existingSnoozes.map(async (notificationId) => {
            try {
              await Notifications.cancelScheduledNotificationAsync(
                notificationId,
              );
            } catch (error) {
              console.warn("Could not cancel an older snooze:", error);
            }
          }),
        );

        const snoozeDate = getSnoozeDate(minutes);

        if (snoozeDate.getTime() <= Date.now()) {
          Alert.alert("Invalid snooze time", "Choose a time in the future.");
          return;
        }

        const permission = await Notifications.getPermissionsAsync();

        let granted = permission.granted;

        if (!granted) {
          granted = (await Notifications.requestPermissionsAsync()).granted;
        }

        if (!granted) {
          Alert.alert(
            "Notifications are disabled",
            "Allow Matrix to send notifications in your device settings.",
          );
          return;
        }

        const snoozeNotificationId =
          await Notifications.scheduleNotificationAsync({
            content: {
              title: "Matrix Reminder",
              body: current.title,
              sound: "default",
              categoryIdentifier: NOTIFICATION_CATEGORY,
              data: {
                reminderId: current.id,
                kind: "snooze",
              },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: snoozeDate,
              ...getNotificationChannel(),
            },
          });

        const latest = remindersRef.current.find(
          (item) => item.id === current.id,
        );

        if (!latest) {
          await Notifications.cancelScheduledNotificationAsync(
            snoozeNotificationId,
          );
          return;
        }

        const updated = remindersRef.current.map((item) =>
          item.id === latest.id
            ? {
                ...item,
                snoozedNotificationIds: [snoozeNotificationId],
              }
            : item,
        );

        await saveReminders(updated);

        const durationLabel =
          minutes === -1
            ? "tomorrow"
            : minutes === 60
              ? "in 1 hour"
              : `in ${minutes} minutes`;

        Alert.alert(
          "Reminder snoozed",
          `"${current.title}" will remind you ${durationLabel}.`,
        );
      } catch (error) {
        console.error("Could not snooze reminder:", error);
        Alert.alert(
          "Couldn't snooze reminder",
          "Matrix could not schedule the snooze. Please try again.",
        );
      }
    },
    [saveReminders],
  );

  const completeReminder = useCallback(
    async (reminder: Reminder, notificationId?: string) => {
      try {
        const current = remindersRef.current.find(
          (item) => item.id === reminder.id,
        );

        if (!current) {
          return;
        }

        const isRecurring = getRecurrence(current) !== "once";
        const snoozeIds = current.snoozedNotificationIds ?? [];

        if (!isRecurring) {
          // Completing a one-time reminder removes it and cancels
          // its original notification and any pending snoozes.
          const idsToCancel = [current.notificationId, ...snoozeIds];

          await Promise.all(
            [...new Set(idsToCancel)].map(async (id) => {
              try {
                await Notifications.cancelScheduledNotificationAsync(id);
              } catch (error) {
                console.warn("Could not cancel notification:", error);
              }
            }),
          );

          await saveReminders(
            remindersRef.current.filter((item) => item.id !== current.id),
          );

          return;
        }

        // A recurring reminder remains saved. Completing a regular
        // occurrence cancels pending snoozes, but not its recurring schedule.
        const idsToCancel =
          notificationId && snoozeIds.includes(notificationId)
            ? [notificationId]
            : snoozeIds;

        await Promise.all(
          idsToCancel.map(async (id) => {
            try {
              await Notifications.cancelScheduledNotificationAsync(id);
            } catch (error) {
              console.warn("Could not cancel snoozed notification:", error);
            }
          }),
        );

        const remainingSnoozes = snoozeIds.filter(
          (id) => !idsToCancel.includes(id),
        );

        const updated = remindersRef.current.map((item) =>
          item.id === current.id
            ? {
                ...item,
                snoozedNotificationIds: remainingSnoozes,
              }
            : item,
        );

        await saveReminders(updated);
      } catch (error) {
        console.error("Could not complete reminder:", error);
        Alert.alert(
          "Couldn't complete reminder",
          "Matrix could not update this reminder. Please try again.",
        );
      }
    },
    [saveReminders],
  );

  const handleNotificationResponse = useCallback(
    async (response: Notifications.NotificationResponse) => {
      const request = response.notification.request;
      const actionIdentifier = response.actionIdentifier;
      const data = request.content.data as {
        reminderId?: string;
        kind?: string;
      };

      const reminderId = data.reminderId;

      if (!reminderId) {
        return;
      }

      // Prevent the same response from being processed twice when
      // the app is opened from a notification.
      const responseKey = `${request.identifier}:${actionIdentifier}`;

      if (lastResponseKeyRef.current === responseKey) {
        return;
      }

      lastResponseKeyRef.current = responseKey;

      const reminder = remindersRef.current.find(
        (item) => item.id === reminderId,
      );

      if (!reminder) {
        return;
      }

      if (actionIdentifier === NOTIFICATION_ACTIONS.COMPLETE) {
        await completeReminder(reminder, request.identifier);
        return;
      }

      if (actionIdentifier === NOTIFICATION_ACTIONS.SNOOZE_15) {
        await snoozeReminder(reminder, 15);
        return;
      }

      if (actionIdentifier === NOTIFICATION_ACTIONS.SNOOZE_OPTIONS) {
        Alert.alert(
          "Snooze reminder",
          `When should Matrix remind you about "${reminder.title}"?`,
          [
            {
              text: "5 minutes",
              onPress: () => {
                void snoozeReminder(reminder, 5);
              },
            },
            {
              text: "15 minutes",
              onPress: () => {
                void snoozeReminder(reminder, 15);
              },
            },
            {
              text: "1 hour",
              onPress: () => {
                void snoozeReminder(reminder, 60);
              },
            },
            {
              text: "Tomorrow",
              onPress: () => {
                void snoozeReminder(reminder, -1);
              },
            },
            {
              text: "Cancel",
              style: "cancel",
            },
          ],
        );
      }
    },
    [completeReminder, snoozeReminder],
  );

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        void handleNotificationResponse(response);
      },
    );

    // Also process a notification action that launched the app from
    // a closed state.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          void handleNotificationResponse(response);
        }
      })
      .catch((error) => {
        console.warn("Could not read the last notification response:", error);
      });

    return () => {
      subscription.remove();
    };
  }, [handleNotificationResponse]);

  async function addReminder() {
    const cleanTitle = title.trim();

    if (!cleanTitle) {
      Alert.alert("Add a reminder", "Enter what you want to remember.");
      return;
    }

    if (reminderDate.getTime() <= Date.now()) {
      Alert.alert(
        "Choose a future time",
        "Your reminder must be scheduled for a time in the future.",
      );
      return;
    }

    setSaving(true);

    try {
      const permission = await Notifications.getPermissionsAsync();

      let granted = permission.granted;

      if (!granted) {
        granted = (await Notifications.requestPermissionsAsync()).granted;
      }

      if (!granted) {
        Alert.alert(
          "Notifications are disabled",
          "Allow Matrix to send notifications in your device settings, then try again.",
        );
        return;
      }

      // Generate the reminder ID before scheduling so the notification
      // can identify its reminder when an action is pressed.
      const reminderId = `${Date.now()}-${Math.random()}`;

      const notificationTriggerOptions = getNotificationChannel();

      let trigger: Notifications.NotificationTriggerInput;

      if (recurrence === "once") {
        trigger = {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: reminderDate,
          ...notificationTriggerOptions,
        };
      } else if (recurrence === "daily") {
        trigger = {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: reminderDate.getHours(),
          minute: reminderDate.getMinutes(),
          ...notificationTriggerOptions,
        };
      } else if (recurrence === "weekly") {
        trigger = {
          type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday: reminderDate.getDay() + 1,
          hour: reminderDate.getHours(),
          minute: reminderDate.getMinutes(),
          ...notificationTriggerOptions,
        };
      } else {
        trigger = {
          type: Notifications.SchedulableTriggerInputTypes.MONTHLY,
          day: reminderDate.getDate(),
          hour: reminderDate.getHours(),
          minute: reminderDate.getMinutes(),
          ...notificationTriggerOptions,
        };
      }

      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Matrix Reminder",
          body: cleanTitle,
          sound: "default",
          categoryIdentifier: NOTIFICATION_CATEGORY,
          data: {
            reminderId,
            title: cleanTitle,
            recurrence,
            kind: "regular",
          },
        },
        trigger,
      });

      const newReminder: Reminder = {
        id: reminderId,
        title: cleanTitle,
        date: reminderDate.toISOString(),
        notificationId,
        recurrence,
        snoozedNotificationIds: [],
      };

      await saveReminders([newReminder, ...remindersRef.current]);

      setTitle("");
      setRecurrence("once");
      setReminderDate(new Date(Date.now() + 60 * 60 * 1000));
      setNow(Date.now());

      Alert.alert(
        "Reminder saved",
        recurrence === "once"
          ? "Matrix has saved your reminder and scheduled its notification."
          : `Matrix will remind you ${
              recurrence === "daily"
                ? "every day"
                : recurrence === "weekly"
                  ? "every week"
                  : "every month"
            } at the selected time.`,
      );
    } catch (error) {
      console.error("Could not create reminder:", error);
      Alert.alert(
        "Couldn't save reminder",
        "Something went wrong. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteReminder(reminder: Reminder) {
    try {
      const idsToCancel = [
        reminder.notificationId,
        ...(reminder.snoozedNotificationIds ?? []),
      ];

      await Promise.all(
        [...new Set(idsToCancel)].map(async (id) => {
          try {
            await Notifications.cancelScheduledNotificationAsync(id);
          } catch (error) {
            console.warn("Could not cancel notification:", error);
          }
        }),
      );

      await saveReminders(
        remindersRef.current.filter((item) => item.id !== reminder.id),
      );
    } catch (error) {
      console.error("Could not delete reminder:", error);
      Alert.alert("Couldn't delete reminder", "Please try again.");
    }
  }

  function formatDate(value: string | Date) {
    return new Date(value).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(value: string | Date) {
    return new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const upcomingReminders = useMemo(
    () =>
      reminders
        .filter(
          (reminder) =>
            getRecurrence(reminder) !== "once" ||
            new Date(reminder.date).getTime() >= now,
        )
        .sort(
          (a, b) =>
            nextOccurrence(a, new Date(now)).getTime() -
            nextOccurrence(b, new Date(now)).getTime(),
        ),
    [reminders, now],
  );

  const overdueReminders = useMemo(
    () =>
      reminders
        .filter(
          (reminder) =>
            getRecurrence(reminder) === "once" &&
            new Date(reminder.date).getTime() < now,
        )
        .sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        ),
    [reminders, now],
  );

  const sections: ReminderSection[] = [
    { title: "UPCOMING", data: upcomingReminders },
    { title: "OVERDUE", data: overdueReminders },
  ].filter((section) => section.data.length > 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#11111B" />

      <View style={styles.header}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>M</Text>
        </View>

        <View>
          <Text style={styles.appName}>MATRIX</Text>
          <Text style={styles.tagline}>Your time. Your priorities.</Text>
        </View>
      </View>

      <SectionList<Reminder>
        style={styles.list}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        sections={sections}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.count}>{section.data.length}</Text>
          </View>
        )}
        ListHeaderComponent={
          <View>
            <Text style={styles.heading}>Reminders</Text>
            <Text style={styles.description}>Make time for what matters.</Text>

            <View style={styles.form}>
              <Text style={styles.label}>WHAT DO YOU NEED TO DO?</Text>

              <TextInput
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Take medication"
                placeholderTextColor="#77778A"
                returnKeyType="done"
                maxLength={150}
              />

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

              <Text style={[styles.label, styles.repeatLabel]}>REPEAT</Text>

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
                  ? "Send one notification at the selected date and time."
                  : recurrence === "daily"
                    ? "Repeat every day at the selected time."
                    : recurrence === "weekly"
                      ? `Repeat every ${reminderDate.toLocaleDateString([], {
                          weekday: "long",
                        })} at the selected time.`
                      : `Repeat on day ${reminderDate.getDate()} of each month at the selected time.`}
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
                  {saving ? "SAVING..." : "+  CREATE REMINDER"}
                </Text>
              </Pressable>
            </View>

            {loading && (
              <Text style={styles.emptyText}>Loading your reminders...</Text>
            )}
          </View>
        }
        renderItem={({ item }) => {
          const isOverdue =
            getRecurrence(item) === "once" &&
            new Date(item.date).getTime() < now;

          const shownDate =
            getRecurrence(item) === "once"
              ? new Date(item.date)
              : nextOccurrence(item, new Date(now));

          return (
            <View style={styles.reminderCard}>
              <View
                style={[
                  styles.reminderMarker,
                  isOverdue && styles.reminderMarkerOverdue,
                ]}
              />

              <View style={styles.reminderDetails}>
                <Text style={styles.reminderTitle}>{item.title}</Text>

                <Text style={styles.reminderDate}>
                  {formatDate(shownDate)} · {formatTime(shownDate)}
                </Text>

                {getRecurrence(item) !== "once" && (
                  <Text style={styles.repeatBadge}>
                    {recurrenceLabel(item.recurrence)}
                  </Text>
                )}

                {(item.snoozedNotificationIds?.length ?? 0) > 0 && (
                  <Text style={styles.snoozeBadge}>Snooze scheduled</Text>
                )}
              </View>

              <Pressable
                style={styles.deleteButton}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${item.title}`}
                onPress={() =>
                  Alert.alert(
                    "Delete reminder?",
                    `Remove "${item.title}" and cancel its notifications?`,
                    [
                      { text: "Keep", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => {
                          void deleteReminder(item);
                        },
                      },
                    ],
                  )
                }
              >
                <Text style={styles.deleteText}>×</Text>
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>◷</Text>
              <Text style={styles.emptyTitle}>Nothing scheduled yet</Text>
              <Text style={styles.emptyText}>
                Your reminders will appear here after you create one.
              </Text>
            </View>
          ) : null
        }
      />

      <View style={styles.footer}>
        <Text style={styles.footerText}>MATRIX · SIMPLE BY DESIGN</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#11111B",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 22,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: "#29293A",
    gap: 12,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: "#7955F5",
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    color: "#FFFFFF",
    fontSize: 25,
    fontWeight: "800",
  },
  appName: {
    color: "#FFFFFF",
    fontSize: 19,
    fontWeight: "800",
    letterSpacing: 3,
  },
  tagline: {
    color: "#9B9BAF",
    fontSize: 12,
    marginTop: 3,
  },
  list: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 24,
    flexGrow: 1,
  },
  heading: {
    color: "#FFFFFF",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  description: {
    color: "#A3A3B7",
    fontSize: 14,
    marginTop: 7,
    marginBottom: 25,
  },
  form: {
    backgroundColor: "#1B1B29",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#303044",
    padding: 18,
  },
  label: {
    color: "#A9A5C5",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
    marginBottom: 10,
  },
  input: {
    backgroundColor: "#11111B",
    borderWidth: 1,
    borderColor: "#35354A",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: "#FFFFFF",
    fontSize: 15,
    marginBottom: 22,
  },
  dateRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  dateButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    padding: 11,
    backgroundColor: "#11111B",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#35354A",
  },
  dateIcon: {
    color: "#A48BFF",
    fontSize: 22,
  },
  dateCaption: {
    color: "#8D8DA4",
    fontSize: 9,
    fontWeight: "700",
    marginBottom: 4,
  },
  dateValue: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
  repeatLabel: {
    marginTop: 2,
  },
  recurrenceRow: {
    flexDirection: "row",
    gap: 7,
    marginBottom: 8,
  },
  recurrenceButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#39394F",
    backgroundColor: "#11111B",
  },
  recurrenceButtonActive: {
    backgroundColor: "#30264D",
    borderColor: "#7955F5",
  },
  recurrenceText: {
    color: "#A3A3B7",
    fontSize: 11,
    fontWeight: "700",
  },
  recurrenceTextActive: {
    color: "#D5CBFF",
  },
  repeatHint: {
    color: "#8989A1",
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 18,
  },
  addButton: {
    backgroundColor: "#7955F5",
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  addButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 30,
    marginBottom: 14,
  },
  sectionTitle: {
    color: "#B6B2CF",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.8,
  },
  count: {
    overflow: "hidden",
    color: "#C7B9FF",
    backgroundColor: "#30264D",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: "700",
  },
  reminderCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1B1B29",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#303044",
    padding: 15,
    marginBottom: 10,
    gap: 12,
  },
  reminderMarker: {
    width: 4,
    alignSelf: "stretch",
    borderRadius: 4,
    backgroundColor: "#9478FF",
  },
  reminderMarkerOverdue: {
    backgroundColor: "#FF6B6B",
  },
  reminderDetails: {
    flex: 1,
  },
  reminderTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  reminderDate: {
    color: "#A3A3B7",
    fontSize: 12,
    marginTop: 6,
  },
  repeatBadge: {
    color: "#B9A8FF",
    fontSize: 10,
    fontWeight: "700",
    marginTop: 5,
  },
  snoozeBadge: {
    color: "#8EDBC0",
    fontSize: 10,
    fontWeight: "700",
    marginTop: 5,
  },
  deleteButton: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  deleteText: {
    color: "#A7A0C0",
    fontSize: 25,
  },
  emptyCard: {
    alignItems: "center",
    backgroundColor: "#1B1B29",
    borderRadius: 14,
    padding: 25,
    borderWidth: 1,
    borderColor: "#303044",
    borderStyle: "dashed",
  },
  emptyIcon: {
    color: "#A48BFF",
    fontSize: 30,
    marginBottom: 10,
  },
  emptyTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  emptyText: {
    color: "#A3A3B7",
    fontSize: 12,
    textAlign: "center",
    lineHeight: 19,
    marginTop: 7,
  },
  footer: {
    paddingVertical: 14,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#29293A",
  },
  footerText: {
    color: "#6F6F86",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 2,
  },
});
