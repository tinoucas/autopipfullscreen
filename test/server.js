// Fake YouTube pages (https, so that HSTS is satisfied): /watch?v=<id>
// plays a video in #movie_player (add &paused=1 to keep it paused); any
// other path is a home page whose only video is a playing hover preview.
const http = require('https'); const fs = require('fs');
const page = (title, inPlayer, play) => `<!doctype html><title>${title}</title>
<body style="margin:0"><div id="masthead-container" style="height:56px;background:#c00">masthead</div>
${inPlayer ? '<div id="player"><div id="movie_player" class="html5-video-player" style="width:640px;height:360px;position:relative"><video class="html5-main-video" muted loop style="width:640px;height:360px;left:0;top:0;position:absolute"></video><div class="ytp-chrome-bottom" style="position:absolute;bottom:0;width:600px;left:12px;height:40px;background:#0008"></div></div></div>'
 : '<div id="preview"><video class="html5-main-video" muted loop></video></div>'}
<div id="below" style="height:2000px">comments</div>
<script>
const c=document.createElement('canvas');c.width=320;c.height=180;const g=c.getContext('2d');let i=0;
setInterval(()=>{g.fillStyle='hsl('+(i++%360)+',50%,50%)';g.fillRect(0,0,320,180)},50);
const v=document.querySelector('video');v.srcObject=c.captureStream(20);${play ? 'v.play();' : ''}
</script>`;
http.createServer({ key: fs.readFileSync(process.env.CERT_DIR + '/key.pem'), cert: fs.readFileSync(process.env.CERT_DIR + '/cert.pem') }, (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html');
  if (u.pathname === '/watch') res.end(page('Video ' + u.searchParams.get('v') + ' - YouTube', true, u.searchParams.get('paused') !== '1'));
  else res.end(page('YouTube', false, true)); // home page with a playing hover preview
}).listen(8443);
