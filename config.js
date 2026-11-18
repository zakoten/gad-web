// config.js
// Indirizzo del broker. Per provare in locale si apre la pagina con ?broker=ws://127.0.0.1:9001
window.GAD_CONFIG = {
  // Da sostituire con l'indirizzo del deployment EMQX Serverless (porta 8084, percorso /mqtt)
  brokerUrl: "wss://REPLACE-ME.emqxsl.com:8084/mqtt",
  topicRoot: "gad/v1",
  adminUser: "admin",
};
