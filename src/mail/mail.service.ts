import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('AWS_SMTP_HOST') ?? 'email-smtp.us-east-1.amazonaws.com',
      port: Number(this.config.get<string>('AWS_SMTP_PORT') ?? 587),
      secure: false, // STARTTLS en el puerto 587
      auth: {
        user: this.config.get<string>('AWS_SMTP_USER'),
        pass: this.config.get<string>('AWS_SMTP_PASSWORD'),
      },
    });
  }

  /**
   * Envía un correo con las credenciales de acceso al usuario.
   */
  async enviarCredenciales(email: string, contraseniaPlana: string, nombre: string): Promise<void> {
    // El dominio eldeber.bo está verificado en Amazon SES: cualquier dirección @eldeber.bo es válida como remitente.
    const from = this.config.get<string>('MAIL_FROM') ?? 'El Deber <no-reply@eldeber.bo>';
    const loginUrl = 'https://suscripciones.eldeber.com.bo/login';

    const html = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #0b1a30; color: #fff; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">¡Bienvenido a El Deber!</h1>
          </div>
          <div style="padding: 20px;">
            <p>Hola <strong>${nombre}</strong>,</p>
            <p>Hemos verificado tu pago e iniciado el alta de tu suscripción. A continuación te proporcionamos tus credenciales de acceso al sistema Paywall de El Deber para que puedas acceder a la edición digital (ePaper) y contenido premium:</p>

            <div style="background-color: #f9f9f9; border-left: 4px solid #fecb00; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0 0 8px 0;"><strong>Usuario:</strong> ${email}</p>
              <p style="margin: 0;"><strong>Contraseña temporal:</strong> <span style="font-family: monospace; font-size: 16px; background: #eee; padding: 2px 6px; border-radius: 3px;">${contraseniaPlana}</span></p>
            </div>

            <p style="text-align: center; margin: 30px 0;">
              <a href="${loginUrl}" style="background-color: #fecb00; color: #0b1a30; text-decoration: none; padding: 12px 30px; font-weight: bold; border-radius: 30px; display: inline-block; font-size: 16px;">Iniciar Sesión</a>
            </p>

            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="font-size: 13px; color: #777;">
              <strong>Recomendación de seguridad:</strong> Por favor, te sugerimos cambiar tu contraseña temporal después de iniciar sesión por primera vez desde tu perfil de usuario.
            </p>
            <p style="font-size: 13px; color: #777;">
              Si tienes algún inconveniente con el acceso, puedes responder a este correo o contactarnos directamente.
            </p>
          </div>
          <div style="background-color: #f1f1f1; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            © ${new Date().getFullYear()} El Deber. Todos los derechos reservados.
          </div>
        </div>
      `;

    try {
      this.logger.log(`Enviando credenciales por correo a: ${email}`);

      const info = await this.transporter.sendMail({
        from,
        to: email,
        subject: '🔑 Tus credenciales de acceso - El Deber',
        html,
      });

      this.logger.log(`📧 Correo enviado con éxito a: ${email}. ID: ${info.messageId}`);
    } catch (error: any) {
      this.logger.error(`Error al enviar correo a ${email}: ${error.message}`, error.stack);
      throw error;
    }
  }
}
