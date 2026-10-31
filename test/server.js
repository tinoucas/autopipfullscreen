// Fake video sites (https, so that HSTS is satisfied), told apart by host:
//
// www.youtube.com: /watch?v=<id> plays a video in #movie_player (add
//   &paused=1 to keep it paused); any other path is a home page whose only
//   video is a playing hover preview.
// www.twitch.tv: /<channel> plays a stream (with sound) in a player box with
//   overlaid controls, inside a transformed <main> (which traps
//   position: fixed), next to a chat column; / is the home page, whose big
//   carousel video plays muted.
// vimeo.com: /<id> embeds the player from player.vimeo.com in a frame, next
//   to an ad frame from ads.example.com (a site you didn't choose).
const https = require('https');
const fs = require('fs');

const stream = (selector, play, muted) => `<script>
const c = document.createElement('canvas'); c.width = 320; c.height = 180;
const g = c.getContext('2d'); let i = 0;
setInterval(() => { g.fillStyle = 'hsl(' + (i++ % 360) + ',50%,50%)'; g.fillRect(0, 0, 320, 180); }, 50);
const v = document.querySelector('${selector}');
v.srcObject = c.captureStream(20); v.muted = ${muted}; ${play ? 'v.play();' : ''}
</script>`;

const youtube = (title, inPlayer, play) => `<!doctype html><title>${title}</title>
<body style="margin:0"><div id="masthead-container" style="height:56px;background:#c00">masthead</div>
${inPlayer ? '<div id="player"><div id="movie_player" class="html5-video-player" style="width:640px;height:360px;position:relative"><video class="html5-main-video" muted loop style="width:640px;height:360px;left:0;top:0;position:absolute"></video><div class="ytp-chrome-bottom" style="position:absolute;bottom:0;width:600px;left:12px;height:40px;background:#0008"></div></div></div>'
 : '<div id="preview"><video class="html5-main-video" muted loop></video></div>'}
<div id="below" style="height:2000px">comments</div>
${stream('video', play, true)}`;

const twitch = (channel) => `<!doctype html><title>${channel ? channel + ' - Twitch' : 'Twitch'}</title>
<body style="margin:0;font:14px sans-serif">
<nav id="top-nav" style="height:50px;background:#9146ff">nav</nav>
<div id="root" style="display:flex">
  <main style="flex:1;transform:translateZ(0)">
    <div class="channel-root" style="padding:20px">
      <div class="player-wrap" style="position:relative;width:640px;height:360px">
        <div class="video-ref" style="width:100%;height:100%"><video style="width:100%;height:100%;display:block"></video></div>
        <div class="controls" style="position:absolute;left:0;right:0;bottom:0;height:40px;background:#0008">controls</div>
      </div>
      <h1>${channel ? 'Stream title' : 'Recommended'}</h1>
    </div>
  </main>
  <aside id="chat" style="width:340px;height:800px;background:#eee">chat</aside>
</div>
${stream('video', true, !channel)}`;

const vimeo = (id) => `<!doctype html><title>Clip ${id} on Vimeo</title>
<body style="margin:0;font:14px sans-serif">
<header style="height:60px;background:#1ab7ea">header</header>
<div style="padding:30px;display:flex;gap:20px">
  <div class="player-container" style="width:640px;height:360px"><iframe src="https://player.vimeo.com/video/${id}" width="640" height="360" style="border:0;display:block" allow="autoplay; fullscreen"></iframe></div>
  <iframe id="ad" src="https://ads.example.com/ad" width="300" height="250" style="border:0"></iframe>
</div>
<p style="height:1500px">description</p>`;

const vimeoPlayer = `<!doctype html><body style="margin:0;background:#000">
<div class="player" style="position:relative;width:100vw;height:100vh">
  <div class="vp-video-wrapper" style="position:absolute;inset:0"><div class="vp-video" style="width:100%;height:100%"><video style="width:100%;height:100%;display:block"></video></div></div>
  <div class="vp-controls" style="position:absolute;left:10px;right:10px;bottom:10px;height:36px;background:#0008">controls</div>
</div>
${stream('video', true, false)}`;

https.createServer({ key: fs.readFileSync(process.env.CERT_DIR + '/key.pem'), cert: fs.readFileSync(process.env.CERT_DIR + '/cert.pem') }, (req, res) => {
  const u = new URL(req.url, 'https://' + req.headers.host);
  res.setHeader('content-type', 'text/html');
  const seg = u.pathname.split('/').filter(Boolean);
  switch (u.hostname) {
    case 'www.twitch.tv': return res.end(twitch(seg[0]));
    case 'vimeo.com': return res.end(vimeo(seg[0] || '1'));
    case 'player.vimeo.com': return res.end(vimeoPlayer);
    case 'ads.example.com': return res.end('<body style="margin:0;background:#fc0">ad</body>');
    default:
      if (u.pathname === '/watch') return res.end(youtube('Video ' + u.searchParams.get('v') + ' - YouTube', true, u.searchParams.get('paused') !== '1'));
      return res.end(youtube('YouTube', false, true)); // home page with a playing hover preview
  }
}).listen(8443);
