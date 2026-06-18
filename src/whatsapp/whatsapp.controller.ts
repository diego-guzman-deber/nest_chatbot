import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  HttpCode,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { WhatsappService } from './whatsapp.service';
import { SignatureGuard } from './signature.guard';

@Controller('webhook')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly whatsappService: WhatsappService) {}

  // ── GET /webhook — Verificación del webhook de Meta ────────────────────────
  @Get()
  verify(@Query() query: Record<string, string>, @Res() res: Response) {
    const challenge = this.whatsappService.verifyWebhook(query);
    if (challenge) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ status: 'error', message: 'Verificación fallida' });
  }

  // ── POST /webhook — Recibir mensajes de WhatsApp ───────────────────────────
  @Post()
  @HttpCode(200)
  @UseGuards(SignatureGuard)
  async receive(@Body() body: any) {
    // Procesar en background — siempre responder 200 a Meta rápido
    this.whatsappService.handleIncoming(body).catch((err) => {
      this.logger.error('Error procesando mensaje entrante', err?.stack ?? err);
    });
    return { status: 'ok' };
  }
}
