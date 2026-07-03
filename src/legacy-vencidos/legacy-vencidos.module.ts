import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LegacyVencidosCampanaService } from './legacy-vencidos-campana.service';
import { LegacyVencidosController } from './legacy-vencidos.controller';
import { LegacyVencido, LegacyVencidoSchema } from './schemas/legacy-vencido.schema';
import {
  LegacyVencidosCampanaEstado,
  LegacyVencidosCampanaEstadoSchema,
} from './schemas/legacy-vencidos-campana-estado.schema';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LegacyVencido.name, schema: LegacyVencidoSchema },
      { name: LegacyVencidosCampanaEstado.name, schema: LegacyVencidosCampanaEstadoSchema },
    ]),
    WhatsappModule,
  ],
  controllers: [LegacyVencidosController],
  providers: [LegacyVencidosCampanaService],
})
export class LegacyVencidosModule {}
