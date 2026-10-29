import { useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { HASH_EXAMPLES, runHashExample, type HashExampleId } from './src/hashExamples';

type ExampleResult = Awaited<ReturnType<typeof runHashExample>>;
type Result =
  | { status: 'passed' | 'done'; value: ExampleResult }
  | { status: 'error'; message: string };

function ExampleScreen() {
  const dark = useColorScheme() === 'dark';
  const colors = dark
    ? {
        background: '#11191d',
        surface: '#1b272d',
        text: '#edf5f5',
        muted: '#b3c4cb',
        border: '#3d535c',
      }
    : {
        background: '#f0f5f6',
        surface: '#ffffff',
        text: '#182c35',
        muted: '#536974',
        border: '#c8d7dc',
      };
  const [input, setInput] = useState('hello');
  const [results, setResults] = useState<Partial<Record<HashExampleId, Result>>>({});
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('Run the reference checks or try your own text.');
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function execute(id: HashExampleId, text: string): Promise<boolean> {
    try {
      const value = await runHashExample(id, text);
      if (mounted.current)
        setResults((current) => ({
          ...current,
          [id]: { status: value.expected === null ? 'done' : 'passed', value },
        }));
      return value.expected !== null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mounted.current)
        setResults((current) => ({ ...current, [id]: { status: 'error', message } }));
      return false;
    }
  }

  async function run(id?: HashExampleId): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setSummary('Running…');
    try {
      if (id !== undefined) {
        await execute(id, input);
        if (mounted.current) setSummary('Run all checks to verify the four reference cases.');
      } else {
        setInput('hello');
        setResults({});
        let passed = 0;
        for (const example of HASH_EXAMPLES) {
          if (!mounted.current) return;
          if (await execute(example.id, 'hello')) passed += 1;
        }
        if (mounted.current) setSummary(`${passed}/4 checks passed`);
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.eyebrow, { color: colors.muted }]}>REACT NATIVE · NITRO MODULES</Text>
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
          xxHash example
        </Text>
        <Text style={[styles.intro, { color: colors.muted }]}>
          Four ways to hash the same bytes with XXH3-64.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Run all checks"
          testID="run-all-checks"
          disabled={busy}
          onPress={() => {
            void run();
          }}
          style={({ pressed }) => [styles.primaryButton, { opacity: busy || pressed ? 0.6 : 1 }]}
        >
          <Text style={styles.primaryButtonText}>{busy ? 'Running…' : 'Run all checks'}</Text>
        </Pressable>
        <Text
          accessibilityLiveRegion="polite"
          testID="check-summary"
          style={[styles.summary, { color: colors.text }]}
        >
          {summary}
        </Text>
        <View style={styles.inputGroup}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Text input</Text>
          <TextInput
            accessibilityLabel="Text to hash"
            testID="hash-input"
            value={input}
            onChangeText={setInput}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            style={[
              styles.input,
              { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          />
        </View>
        {HASH_EXAMPLES.map((example) => {
          const result = results[example.id];
          return (
            <View
              key={example.id}
              style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <View style={styles.cardHeading}>
                <Text accessibilityRole="header" style={[styles.cardTitle, { color: colors.text }]}>
                  {example.title}
                </Text>
                {result !== undefined ? (
                  <Text
                    style={[
                      styles.badge,
                      {
                        color:
                          result.status === 'error'
                            ? dark
                              ? '#ffb4b4'
                              : '#ae2837'
                            : dark
                              ? '#81dece'
                              : '#08786b',
                      },
                    ]}
                  >
                    {result.status === 'passed'
                      ? 'PASS'
                      : result.status === 'done'
                        ? 'DONE'
                        : 'ERROR'}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.description, { color: colors.muted }]}>
                {example.description}
              </Text>
              {result !== undefined ? (
                result.status === 'error' ? (
                  <Text selectable style={[styles.output, { color: dark ? '#ffb4b4' : '#ae2837' }]}>
                    {result.message}
                  </Text>
                ) : (
                  <View style={styles.result}>
                    <Text
                      selectable
                      testID={`digest-${example.id}`}
                      style={[styles.digest, { color: colors.text }]}
                    >
                      {result.value.digest}
                    </Text>
                    <Text style={[styles.detail, { color: colors.muted }]}>
                      {result.value.detail}
                    </Text>
                  </View>
                )
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={example.title}
                testID={`run-${example.id}`}
                disabled={busy}
                onPress={() => {
                  void run(example.id);
                }}
                style={({ pressed }) => [
                  styles.caseButton,
                  { borderColor: colors.border, opacity: busy || pressed ? 0.5 : 1 },
                ]}
              >
                <Text style={[styles.caseButtonText, { color: colors.text }]}>{example.title}</Text>
              </Pressable>
            </View>
          );
        })}
        <Text style={[styles.footer, { color: colors.muted }]}>
          Reference input: hello · Expected: 9555e8555c62dcfd{'\n'}
          xxHash is a non-cryptographic hash.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ExampleScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 22, gap: 14, maxWidth: 680, width: '100%', alignSelf: 'center' },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.1 },
  heading: { fontSize: 32, fontWeight: '700', letterSpacing: -1 },
  intro: { fontSize: 16, lineHeight: 23 },
  primaryButton: {
    backgroundColor: '#08786b',
    borderRadius: 12,
    minHeight: 48,
    padding: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  summary: { fontSize: 14, lineHeight: 20 },
  inputGroup: { gap: 7, marginTop: 3 },
  inputLabel: { fontSize: 14, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
    fontSize: 16,
  },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 11 },
  cardHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitle: { fontSize: 18, fontWeight: '700', flexShrink: 1 },
  badge: { fontSize: 12, fontWeight: '800' },
  description: { fontSize: 14, lineHeight: 21 },
  result: { gap: 5 },
  digest: { fontSize: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  detail: { fontSize: 12, lineHeight: 18 },
  output: { fontSize: 14, lineHeight: 21 },
  caseButton: {
    borderWidth: 1,
    borderRadius: 9,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 10,
  },
  caseButtonText: { fontSize: 14, fontWeight: '600' },
  footer: { fontSize: 12, lineHeight: 19, marginVertical: 8 },
});
