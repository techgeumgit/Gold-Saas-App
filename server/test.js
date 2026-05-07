const http = require('http');
const server = http.createServer((req, res) => {
  res.end('ok');
});
server.listen(5000, () => {
  console.log('Listening on 5000');
});
// Let's also print if it exits
process.on('exit', () => console.log('Exiting!'));
