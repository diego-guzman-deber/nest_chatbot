import { Module } from '@nestjs/common';
import { RecordatoriosService } from './recordatorios.service';
import { SuscripcionesModule } from '../suscripciones/suscripciones.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [SuscripcionesModule, WhatsappModule],
  providers: [RecordatoriosService],
})
export class RecordatoriosModule {}
