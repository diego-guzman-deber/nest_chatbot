import { Controller, ForbiddenException, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LegacyVencidosCampanaService } from './legacy-vencidos-campana.service';

/**
 * Endpoint de uso único (o repetible sin riesgo, es idempotente) para cargar
 * en Mongo los suscriptores legacy ya resueltos, corriendo DENTRO del
 * servidor de producción — que sí tiene acceso a Mongo, a diferencia de la
 * máquina donde se corre el script de fusión.
 *
 * Requiere el header/query `token` igual a ADMIN_SEED_TOKEN (.env del
 * servidor). Sin esa variable configurada, el endpoint rechaza todo.
 */
@Controller('legacy-vencidos')
export class LegacyVencidosController {
  constructor(
    private readonly campanaService: LegacyVencidosCampanaService,
    private readonly config: ConfigService,
  ) {}

  @Post('sembrar')
  async sembrar(@Query('token') token: string) {
    const tokenEsperado = this.config.get<string>('ADMIN_SEED_TOKEN');
    if (!tokenEsperado || token !== tokenEsperado) {
      throw new ForbiddenException('Token inválido o ADMIN_SEED_TOKEN no configurado en el servidor.');
    }
    return this.campanaService.sembrarDesdeArchivoEmbebido();
  }
}
