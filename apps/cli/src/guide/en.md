# Driving VibeValley from the command line

For the agents on this machine (and the owner): each command is one thing to do. Answers are short text by default, one item a line, starting with the name to use next (`#12`, `#general`, `w3`); add `--format json` for the endpoint's shape.

## First, look

```bash
vibevalley doctor                 # which farm was found, whether it answers, the runtimes, missing keys
vibevalley issue list --waiting   # issues waiting on the owner
vibevalley issue show 12          # one issue: where it stands, its questions and criteria, what can be done now
```

The last line of `issue show` lists the commands the issue takes now; a command it does not take is refused, naming the ones it does.

## Write an issue and send it out

```bash
vibevalley issue new 'Fix the login page' --project web --agent lao-zhou --criterion 'expired sessions go back to login' --key login-1
vibevalley issue work 13          # send it and wait for the hand-back; each status on stderr, the change at the end
vibevalley issue work 13 --no-wait
vibevalley issue work 9           # done or closed: reopened first, then sent out
```

`--key`: sending again with the same key does not make a second issue, so a retry is safe.

## The helper asks

```bash
vibevalley issue show 13          # under "Questions", what it asks, with the answers it thought of
vibevalley issue say 13 'use 8797'   # it is asking: what you say is the answer
vibevalley issue say 13 'leave the database alone'   # not asking: a word passed on to it
```

## Review

```bash
vibevalley issue show 13 --diff     # with its change (--log: its timeline and cost)
vibevalley issue accept 13
vibevalley issue say 13 'expired sessions do not go back to login'   # waiting for review: sends it back
```

## Channels

```bash
vibevalley channel read general --limit 10
vibevalley channel say general '@w3 look at the login page first'
```

## Notes

```bash
vibevalley pkm capture 'a remember-me box on the login page'
pbpaste | vibevalley pkm capture --page Reading
vibevalley pkm show                # today's journal (--day for another)
vibevalley pkm show Reading
```

## Finding things

Not sure where it was written: one command searches the issues, channels, notes and memories, each under its own heading.

```bash
vibevalley search login expired
vibevalley search 'reading list' --in notes
```

## Before changing anything

Every command that changes something takes `--dry-run`: where there is a dry run it says what it would do and changes nothing; where there is none it is refused, never done quietly.

## When something fails

stderr's last line is `{"error":{"tag":…,"message":…,"next":[{"say":…,"run":[…]}]}}`: `next` is what can be done next, `run` a command to run as it is (without `vibevalley`). Exit codes: 0 done, 2 the command was written wrong, 3 refused, 4 not found, 5 no farm to reach.

## Other endpoints

Every endpoint without a command can be called directly:

```bash
vibevalley api list --module pkm               # what each endpoint does
vibevalley api list --module pkm --format json # with its request body's JSON Schema
vibevalley api call issue.get --json '{"id":"12"}'
```
