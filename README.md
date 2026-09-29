# Rei dos Mares — servidor multiplayer

Servidor Node.js + Socket.IO da beta 3.0.3.

## Produção

Comando de inicialização:

```bash
npm start
```

O servidor usa `process.env.PORT` automaticamente e escuta em `0.0.0.0`.

### Variáveis recomendadas

- `FRONTEND_ORIGINS=https://pandapidio.github.io`
- `REJOIN_MS=30000`

`FRONTEND_ORIGINS` aceita várias origens separadas por vírgula.

## Endpoints

- `/` — identificação do serviço
- `/health` — saúde, versão, conexões e número de salas
- `/socket.io/` — Socket.IO
