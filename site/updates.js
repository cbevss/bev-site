/* What's new: the list the "What's new" popup shows to people who are signed in.
 * Newest update first. Every update gets an id (the bot's version), a date, and one entry per change:
 * `title` is the command or part of BEV that changed or was added, `text` says what changed in plain words.
 * Someone who presses "Got it" doesn't see the popup again until an update with a new id is added here.
 */
window.BEV_UPDATES = [
  {
    id: '4.14',
    date: '26 October 2026',
    changes: [
      { title: 'Dashboard Access (new)',
        text: "A new card in the Security section lets you give a role, or particular members, access to this server's dashboard without making them admins. Tick exactly which cards each one can see and change. They never see the Dashboard Access card, so they can't give themselves more." },
      { title: 'Requests to be freed: staff alerts',
        text: 'Pick a channel and a role on the Jail card, and BEV posts each new request there, pinging that role, with a button to review it.' },
      { title: 'Requests to be freed: approving and denying',
        text: 'Approve can now free them with a warning or with a 24-hour timeout, and add a note for their DM. Deny can say why, and they see it in the jail channel.' },
      { title: 'Requests to be freed: what they were jailed for and history',
        text: "Each request shows what they were jailed for at the top, plus their earlier requests and how they were answered. Member tools on the dashboard show someone's requests too." },
    ],
  },
  {
    id: '4.13',
    date: '26 October 2026',
    changes: [
      { title: 'Jail: requests to be freed',
        text: "People in jail can ask to be freed by sending one message in the jail channel. BEV deletes it straight away and keeps it for the staff, and anything else they send there is deleted. Only their first message counts. If they're denied, they can ask again after 7 days." },
      { title: 'Requests to be freed (dashboard)',
        text: "A new button on the Jail card opens a window listing everyone who asked, newest first, with their picture, display name and @username. Pick someone to read their message, then Approve (they're freed and told by DM) or Deny (they stay, and are told in the jail channel)." },
      { title: 'Jail reflection message',
        text: "The reflection message now explains how to ask to be freed. It's still posted in a box, with the jail role's ping just above it so everyone in jail is notified." },
      { title: 'Let people in jail ask to be freed (setting)',
        text: 'A new Jail setting, on by default. Turn it off and people in jail can chat in the jail channel as normal.' },
    ],
  },
  {
    id: '4.12',
    date: '26 October 2026',
    changes: [
      { title: 'Commands follow your dashboard',
        text: "A feature's commands now only show in Discord's command list in servers where that feature is switched on. For example, /star only appears once the Starboard is on. Switch a feature on or off and its commands are added or removed within a few seconds. Discord's app may need a restart (or Ctrl+R) to show the change." },
      { title: '/help',
        text: "/help now lists only the commands your server can use. Everyday commands like /help, /dashboard and the moderation commands are always there." },
    ],
  },
  {
    id: '4.11',
    date: '26 October 2026',
    changes: [
      { title: '/star',
        text: 'A new Starboard command. Reply to any message with !star and BEV gives it a star, then tidies the !star away. Using /star on its own privately explains how, because Discord never sends slash commands as replies.' },
      { title: 'Star message (Apps menu)',
        text: 'Right-click a message (or hold it on your phone), then pick Apps → Star message to star it. These stars count together with ⭐ reactions, and nobody is counted twice.' },
    ],
  },
  {
    id: '4.10',
    date: '26 October 2026',
    changes: [
      { title: 'Every message BEV sends',
        text: 'Replies, command answers, DMs and posts now all come in a coloured box. Errors are red, successes green and warnings amber. Anyone a message pings is still pinged, with their mention just above the box.' },
      { title: '/jail',
        text: "Jailing someone now resets their level and XP to 0 and takes them off this week's leaderboard. They don't get their level reward roles back when they're released. You can turn this off with \"Reset their level and XP when jailed\" on the Jail card." },
      { title: 'Jail reflection message',
        text: "The reflection message is now posted in a box, and tells the people in jail that their level and XP have been reset." },
      { title: 'Role menus',
        text: 'When a long list menu is split into several boxes, every box is now the same full width, so they line up neatly.' },
      { title: "What's new popup",
        text: "When you sign in after an update, this popup lists everything that changed. Press Got it and you won't see it again until the next update." },
    ],
  },
];
