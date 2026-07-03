import { Module } from '@nestjs/common';
import { RecordatoriosService } from './recordatorios.service';
import { ExpiracionService } from './expiracion.service';
import { SuscripcionesModule } from '../suscripciones/suscripciones.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { EspoCrmModule } from '../espocrm/espocrm.module';

@Module({
  imports: [SuscripcionesModule, WhatsappModule, EspoCrmModule],
  providers: [RecordatoriosService, ExpiracionService],
})
export class RecordatoriosModule {}
