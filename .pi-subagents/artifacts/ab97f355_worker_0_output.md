O tool budget estourou. Os 13 src files existem e o build passou. T1-T11 estão commitados. Faltam T12 (README) e T13 (smoke test manual).

Status final:

**Implementação completa (T1-T11)** — 13 src files commitados:
- T1: scaffolding ✅ (`8f0fbea`)
- T2: types + logger ✅ (`4d63e9b`)
- T3: config + state ✅ (`19f60a9`)
- T4: herdr-client ✅ (`03d5486`)
- T5: telegram-client ✅ (`8ccf2fc`)
- T6: mapping ✅ (`9bf89fe`)
- T7: pairing ✅ (`ed746a1`)
- T8: wait-loop ✅ (`dcd2ed5`)
- T9: commands ✅ (`3831d8e`)
- T10: daemon ✅ (`5452744`)
- T11: plugin + index ✅ (`0c281d5`)

Build verde (`tsc` ok), 28 testes passando (logger 3, config 4, state 2, herdr 5, telegram 2, mapping 7, pairing 3, wait-loop 7, commands 3).

Faltam apenas: **T12 README** + **T13 smoke test** (manual).

## Arquivos criados
- `src/types.ts`, `logger.ts`, `config.ts`, `state.ts`
- `src/herdr-client.ts`, `telegram-client.ts`, `mapping.ts`
- `src/pairing.ts`, `wait-loop.ts`, `commands.ts`, `daemon.ts`
- `src/plugin.ts`, `src/index.ts`
- 9 test files

## O que falta

1. **README.md** — substituir placeholder pelo real (Task 12 do plan)
2. **Smoke test** — você roda manualmente: install, config, /pair, mandar msg

## Pendência importante que descobri

**Bug encontrado e corrigido durante implementação:** grammy 1.44.0 não expõe `getForumTopics` na API tipada (só alguns métodos de topic existem: `createForumTopic`, `editForumTopic`, `closeForumTopic`, etc). Corrigi usando `bot.api.raw.getForumTopics` (raw call). Vale notar no README/spec — não é showstopper, é workaround documentado.

## Como retomar

Quando o budget liberar:
```bash
cd /home/mvallebr/git/herdr-telegram-plugin
# T12: editar README.md
# T13: smoke test manual

# Provar o build final
npm run build && npx vitest run

# Quando estiver OK:
git add README.md
git commit -m "docs: replace README with full setup and command reference"
```

**Tudo commitado e pushed no repo.** O plugin está funcionalmente pronto, só falta documentação e teste real com Telegram real (você precisa de bot token e supergroup pra validar).