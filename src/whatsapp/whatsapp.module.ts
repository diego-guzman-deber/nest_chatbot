import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { OpenaiService } from './openai.service';
import { SignatureGuard } from './signature.guard';
import { PaymentService } from './payment.service';

@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService, OpenaiService, SignatureGuard, PaymentService],
})
export class WhatsappModule {}
