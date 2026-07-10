import { createApp } from './app.js';
import { BattleManager } from './battle-manager.js';
import { FoulPlayClient } from './foul-play-client.js';


const foulPlayClient = new FoulPlayClient();
const manager = new BattleManager({ foulPlayClient });
const app = createApp(manager);
const port = process.env.PORT || 3000;

app.listen(port, () => {
    console.log(`Battle API listening on port ${port}`);
});

// Keep both free Render services awake only during the established Italian window.
const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://pokemon-battle-api-bj3y.onrender.com';
const wakeTimer = setInterval(async () => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Rome',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
    const time = hour + minute / 60;
    if (time < 11 || time > 23.5) return;

    await Promise.allSettled([
        fetch(renderUrl),
        foulPlayClient.health(),
    ]);
}, 14 * 60 * 1000);
wakeTimer.unref?.();
