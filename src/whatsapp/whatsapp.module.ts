import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { OpenaiService } from './openai.service';
import { SignatureGuard } from './signature.guard';
import { PaymentService } from './payment.service';
import { PlanesModule } from '../planes/planes.module';
import { SuscripcionesModule } from '../suscripciones/suscripciones.module';
import { EspoCrmModule } from '../espocrm/espocrm.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [PlanesModule, SuscripcionesModule, EspoCrmModule, MailModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, OpenaiService, SignatureGuard, PaymentService],
})
export class WhatsappModule {}
