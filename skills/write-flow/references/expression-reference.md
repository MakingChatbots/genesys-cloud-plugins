# Architect Expression Language

Expressions are string values passed to SDK methods like `setExpression()`, `variableValue`, `numberExpression`, etc. They use Genesys Cloud's own expression syntax — not TypeScript.

## Syntax Rules

- **String literals**: double quotes inside the expression — `'"Hello"'` in TypeScript
- **Escape sequences**: `\"` `\\` `\t` `\n` `\r`
- **Decimal separator**: always `.` (culture-invariant)
- **Property access**: dot notation — `Flow.myJson.userName`
- **Collection access**: brackets — `Task.Queues[Task.Index]`
- **NOT_SET**: special "undefined" value, distinct from `""`. Check with `IsSet()` or `IsNotSetOrEmpty()`

## Operators (highest → lowest precedence)

| Precedence | Operators | Notes |
|---|---|---|
| 1 | `[]` `.` | Collection/property access |
| 2 | `-` `!` `~` | Unary minus, logical NOT, bitwise NOT |
| 3 | `^` | Exponentiation (`2^3 = 8`) |
| 4 | `*` `/` `%` | Multiply, divide, modulus |
| 5 | `+` `-` | Add, subtract, string concat |
| 6 | `<` `<=` `>` `>=` | Comparison |
| 7 | `==` `!=` | Equality |
| 8 | `&` | Bitwise AND |
| 9 | `\|` | Bitwise OR |
| 10 | `and` | Logical AND |
| 11 | `or` | Logical OR |

Parentheses `()` override precedence.

## Data Types

### Scalar types

| Type | Range / Notes |
|---|---|
| Boolean | `true` / `false` |
| Integer | -999,999,999,999,999 to 999,999,999,999,999 |
| Decimal | Up to 40 digits precision |
| String | Double-quoted text |
| DateTime | Jan 1 1800 – Dec 31 2200, UTC only |
| Date | Date only (no time) |
| Time | Time only (no date) |
| Duration | Milliseconds (-999T to 999T) |
| Currency | Decimal amount + ISO 4217 code (`MakeCurrency(5.25, "USD")`) |
| Phone Number | Has `.dialingCode` property |
| JSON | Objects, arrays, strings, numbers, booleans, null |

### Network types (org-specific, cannot be created from strings)
Queue, User, Group, ACD Skill, Language Skill, Schedule, Schedule Group, Emergency Group, Wrapup Code

### Collections
Most types have collection variants (String Collection, Integer Collection, Queue Collection, etc.). Access items with `GetAt(collection, index)` (0-based).

### Special values
- `NOT_SET` — undefined, checked with `IsSet()` / `IsNotSetOrEmpty()`
- `System.MinInt` / `System.MaxInt` — integer boundaries
- `System.MinDateTime` / `System.MaxDateTime` — datetime boundaries

### Implicit casting
Architect auto-converts between compatible types. Assigning `3+4` (Integer) to a String variable wraps it as `ToString(3+4)`.

## Variable Scoping

| Prefix | Scope |
|---|---|
| `Flow.` | Entire flow |
| `Task.` | Current task only |
| `State.` | Current state only |
| `Call.` | Built-in, inbound/outbound calls (read-only) |
| `Email.` | Built-in, email flows (read-only) |
| `Message.` | Built-in, messaging flows (read-only) |
| `Chat.` | Built-in, chat flows (read-only) |
| `Session.` | Built-in, bot/survey flows (read-only) |
| `System.` | System constants |

### Common built-in variables

| Variable | Type | Description |
|---|---|---|
| `Call.Ani` | String | Caller's phone number |
| `Call.CalledAddress` | String | Dialed number |
| `Call.ConversationID` | String | Conversation ID |
| `Call.Language` | String | IETF language tag |
| `Call.CurrentQueue` | Queue | Current queue |
| `Flow.IsTest` | Boolean | Debug mode flag |
| `Flow.StartDateTimeUtc` | DateTime | When the flow started |

## Functions

### String

| Function | Description |
|---|---|
| `Append(s1, s2, ...)` | Concatenate (preferred over `+`, handles NOT_SET) |
| `Substring(str, start, length)` | Extract substring |
| `IndexOf(str, search)` | Find position (0-based, -1 if not found) |
| `Contains(str, search)` | Check if substring exists → Boolean |
| `Replace(str, find, replaceWith)` | Replace all occurrences |
| `ToUpper(str)` | Uppercase |
| `ToLower(str)` | Lowercase |
| `Trim(str)` | Remove leading/trailing whitespace |
| `Length(str)` | String length |

### DateTime

| Function | Description |
|---|---|
| `GetCurrentDateTimeUtc()` | Current UTC date/time |
| `MakeDateTime(y, m, d, h, min, s)` | Construct a DateTime |
| `Year(dt)` / `Month(dt)` / `Hour(dt)` | Extract components |
| `DayOfWeek(dt)` | Day of week (integer) |
| `AddHours(dt, n)` | Add/subtract hours |
| `AddMinutes(dt, n)` | Add/subtract minutes |
| `AddDays(dt, n)` | Add/subtract days |

### Type Conversion

| Function | Description |
|---|---|
| `ToString(value)` | Convert to string (appends "Z" for DateTime) |
| `ToInt(str)` | Parse string to integer |
| `ToDecimal(value)` | Convert to decimal |
| `ToDateTime(str)` | Parse string to DateTime |
| `ToDuration(value)` | Convert to duration |
| `ToPhoneNumber(str)` | Convert to PhoneNumber (enables `.dialingCode`) |
| `ToJson(value)` | Convert singleton to JSON |
| `JsonParse(str)` | Parse JSON string (strict: double quotes required) |
| `ToBoolean(value)` | Convert to boolean |

### Logic

| Function | Description |
|---|---|
| `If(cond, trueVal, falseVal)` | Conditional (supports nesting) |
| `IsSet(value)` | True if value is not NOT_SET |
| `IsNotSetOrEmpty(value)` | True if NOT_SET or empty string |

### Collections

| Function | Description |
|---|---|
| `Count(collection)` | Number of items |
| `GetAt(collection, index)` | Item at index (0-based) |
| `AddItem(collection, item)` | Append item |
| `RemoveItem(collection, value)` | Remove by value |
| `RemoveItemAt(collection, index)` | Remove by index |
| `Find(collection, value)` | Find items → collection of matches |
| `FindFirst(collection, value)` | First index (-1 if not found) |
| `RemoveDups(collection)` | Remove duplicates |

### Audio / TTS (voice flows only)

| Function | Description |
|---|---|
| `ToAudioTTS(text)` | Text to speech |
| `ToAudioBlank(duration)` | Silent pause |
| `ToAudioNumber(number)` | Read number aloud |
| `ToAudioPhoneNumber(phone)` | Read phone number aloud |

### Currency

| Function | Description |
|---|---|
| `MakeCurrency(amount, code)` | Create currency (`MakeCurrency(5.25, "USD")`) |

## Common Patterns

### Time-of-day greeting
```
If(Hour(GetCurrentDateTimeUtc()) < 12, "Good morning", If(Hour(GetCurrentDateTimeUtc()) < 17, "Good afternoon", "Good evening"))
```

### Safe variable access (NOT_SET guard)
```
5 + If(IsSet(Flow.MyInteger), Flow.MyInteger, 0)
```

### String concatenation (safe)
```
Append("Hello ", Flow.CustomerName, "!")
```

### Check if caller is in a blocked list
```
Count(Find(Task.BlockedNumbers, ToPhoneNumber(Call.Ani))) > 0
```

### Collection lookup with fallback
```
If(Task.FoundIndex != -1, GetAt(Task.Queues, Task.FoundIndex), Task.DefaultQueue)
```

### Business hours check
```
Hour(GetCurrentDateTimeUtc()) >= 8 and Hour(GetCurrentDateTimeUtc()) <= 17
```

### JSON property access
```
Flow.MyJson.userName
```

### Phone number dialing code
```
ToPhoneNumber(Call.Ani).dialingCode
```

## Expression Quoting in the SDK

Expressions are strings inside strings. The outer quotes are TypeScript, the inner quotes are expression syntax:

```typescript
// String literal in an expression — double quotes inside single quotes
response.messageBody.setExpression('"Hello!"');

// Variable reference — no inner quotes needed
setVar.variableValue = "Flow.customerName";

// Function call with string argument
response.messageBody.setExpression('Append("Hello ", Flow.Name, "!")');

// Conditional with string results
comm.communication.setExpression(
    'If(Hour(GetCurrentDateTimeUtc()) < 12, "Good morning", "Good afternoon")'
);
```

Only string literals inside expressions need the inner double quotes. Variable references, function calls returning non-strings, and numeric literals do not.