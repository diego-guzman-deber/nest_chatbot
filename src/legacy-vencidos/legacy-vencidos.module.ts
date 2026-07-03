import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LegacyVencidosCampanaService } from './legacy-vencidos-campana.service';
import { LegacyVencidosController } from './legacy-vencidos.controller';
import { LegacyVencido, LegacyVencidoSchema } from './schemas/legacy-vencido.schema';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: LegacyVencido.name, schema: LegacyVencidoSchema }]),
    WhatsappModule,
  ],
  controllers: [LegacyVencidosController],
  providers: [LegacyVencidosCampanaService],
})
export class LegacyVencidosModule {}
