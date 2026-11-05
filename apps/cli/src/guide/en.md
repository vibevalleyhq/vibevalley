# Driving VibeValley from the command line

For the agents on this machine (and the owner): the commands follow the farm, one command an operation of the server's, `<resource> [<sub-resource>] <verb>`, the verbs `list`, `show`, `create`, `edit`, `delete` and the resource's own (`status`, `comment`, `send`…). Answers are short text by default, one item a line, starting with the name to use next (`#12`, `#general`, `w3`); `--format json` gives the protocol's shape. A helper is an issue's assignee and moves the issue along for you; what you manage is the issue.

## First, look

```bash
vibevalley doctor                       # which farm, reachable or not, the runtimes, the keys
vibevalley issue list --wants-owner     # the issues waiting on the owner, the longest waiting first
vibevalley issue show 12                # an issue: its status, where it is now, questions, criteria, then the commands it takes now
```

An issue's status is one of `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`. Which move it takes is the server's to say: one it does not take is refused, with the commands it does.

## Write an issue and send it out

```bash
vibevalley issue create 'fix the login page' --project web --agent docs --criterion 'an expired session goes back to login' --key login-1
vibevalley issue status 13 todo         # send it out: to its assignee
vibevalley issue show 13 --watch --timeout 600   # follow it until in_review, done or canceled, then show it; each status on stderr
```

`--key`: sending again with the same key does not make a second issue, so a retry is safe.

## The helper asks

```bash
vibevalley issue show 13                # under "Questions", what it asks, with the answers it thought of
vibevalley issue comment 13 'use 8797'  # a comment: the answer when it asks; read in its next round while it works
vibevalley issue show 13 --watch
```

## Review

```bash
vibevalley issue diff 13                                   # the change: commits and files
vibevalley issue review 13 --pass
vibevalley issue status 13 done --dry-run                  # how completing it would deliver (merge or a PR)
vibevalley issue status 13 done
vibevalley issue review 13 --fail --finding 'expired sessions do not go back to login'
vibevalley issue status 13 todo --comment 'an expired session must go back to login'   # another round
```

## Channels

```bash
vibevalley channel list
vibevalley channel message list general --limit 10
vibevalley channel message send general '@w3 look at the login page first'
vibevalley channel message search port
```

## Notes

```bash
vibevalley pkm capture 'add remember-me to the login page'
pbpaste | vibevalley pkm capture --page Reading
vibevalley pkm search 'reading list'
vibevalley pkm journal show              # today's journal (--day for another)
vibevalley pkm page show Reading         # a page's outline
vibevalley pkm page export Reading       # Markdown to read
vibevalley pkm page edit Reading         # edit its file in $EDITOR
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
