import { Router } from 'express';
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { StartPaymentRequestSchema,PaymentAttemptSchema,PaymentParamsSchema,BookingParamsSchema,BookingSchema,HoldParamsSchema,PaymentNotificationSchema,PaymentNotificationResultSchema,ErrorResponseSchema,type PaymentSimulationJob,type RefundJob } from '@seatrush/shared';
import { verifyPaymentNotification } from '@seatrush/shared/server';
import type { BookingDeps } from './booking.js';
import { customerAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';
import { idempotent } from '../idempotency.js';
import { withDbRetry } from '../booking.js';
import { getPayment,getBooking,startPayment,applyNotification } from '../payments.js';
export interface PaymentDeps extends BookingDeps { paymentWebhookSecret?:string; enqueuePayment?:(job:PaymentSimulationJob)=>Promise<void>; enqueueRefund?:(job:RefundJob)=>Promise<void> }
function parse<T>(schema:z.ZodType<T>,value:unknown):T { const result=schema.safeParse(value); if(!result.success) throw new HttpError(400,'bad_request','Invalid request'); return result.data; }
export function paymentRouter(deps:PaymentDeps): Router {
 const router=Router(); const auth=customerAuth(deps.authTokenSecret,true,deps.prisma);
 router.use(['/payments','/holds/:holdId/payments','/bookings'],(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.post('/payments/notifications',async(req,res)=>{
  if (!req.is("application/json")) throw new HttpError(415,'unsupported_media_type','Content-Type must be application/json');
  if(!deps.paymentWebhookSecret||!Buffer.isBuffer(req.body)||!verifyPaymentNotification(deps.paymentWebhookSecret,req.body,req.get('x-seatrush-signature'))) throw new HttpError(401,'invalid_signature','Invalid notification signature');
  let json:unknown; try {json=JSON.parse(req.body.toString('utf8'));}catch{throw new HttpError(400,'invalid_json','Request body is not valid JSON');}
  const notification=parse(PaymentNotificationSchema,json);
  const result=await withDbRetry(()=>deps.prisma.$transaction(tx=>applyNotification(tx,notification),{maxWait:30000,timeout:30000}));
  if('refundRequiredId' in result) {try{await deps.enqueueRefund?.({refundRequiredId:result.refundRequiredId!});}catch{/* Durable sweep recovers queue loss. */}}
  res.json({disposition:result.disposition});
 });
 router.post('/holds/:holdId/payments',auth,async(req,res)=>{
  const {holdId}=parse(HoldParamsSchema,req.params); const key=parse(z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),req.get('Idempotency-Key'));
  const owned=await deps.prisma.hold.findFirst({where:{id:holdId,customerId:req.customer!.id},select:{screeningId:true}});
  const result=await idempotent(deps.prisma,{customerId:req.customer!.id,screeningId:owned?.screeningId??null,operation:'payment.start',key,payload:{holdId,body:req.body},requestId:String(req.id)},
   (tx,store)=>startPayment(tx,holdId,req.customer!.id,parse(StartPaymentRequestSchema,req.body),store));
  if(result.status===201&&!result.replayed){const attempt=PaymentAttemptSchema.parse(result.body);const request=parse(StartPaymentRequestSchema,req.body);try{await deps.enqueuePayment?.({paymentAttemptId:attempt.id,scenario:attempt.scenario,delayMs:request.delayMs??10000,attemptCreatedAt:Date.parse(attempt.createdAt)});}catch{/* Durable sweep recovers queue loss. */}}
  res.status(result.status).json(result.body);
 });
 router.get('/payments/:paymentAttemptId',auth,async(req,res)=>{const {paymentAttemptId}=parse(PaymentParamsSchema,req.params);res.json(await withDbRetry(()=>getPayment(deps.prisma,paymentAttemptId,req.customer!.id)));});
 router.get('/bookings/:bookingId',auth,async(req,res)=>{const {bookingId}=parse(BookingParamsSchema,req.params);res.json(await withDbRetry(()=>getBooking(deps.prisma,bookingId,req.customer!.id)));});
 return router;
}
export function registerPaymentOpenApi(registry:OpenAPIRegistry):void {
 const response=(schema:z.ZodType)=>({description:'Success',content:{'application/json':{schema}}});
 const errors=(descriptions:Record<number,string>)=>Object.fromEntries(Object.entries(descriptions).map(([code,description])=>
   [code,{description,content:{'application/json':{schema:ErrorResponseSchema}}}]));
 const ownerErrors = {400:'bad_request: invalid path parameters',401:'unauthorized: valid customer bearer token required',
   404:'not_found: unknown resource or another customer’s resource',503:'retry_later: database unavailable or conflict'};
 registry.registerComponent('securitySchemes','PaymentSignature',{type:'apiKey',in:'header',name:'x-seatrush-signature',
   description:'Lowercase hex HMAC-SHA256 over the decoded (post-gzip) JSON body, using PAYMENT_WEBHOOK_SECRET'});
 registry.registerPath({method:'post',path:'/holds/{holdId}/payments',security:[{CustomerBearer:[]}],
   description:'Starts payment. delayMs is allowed only for delayed_success (0–360000 ms; default 10000).',
   request:{params:HoldParamsSchema,headers:z.object({'idempotency-key':z.string().min(1).max(200)}),body:{required:true,content:{'application/json':{schema:StartPaymentRequestSchema}}}},
   responses:{201:response(PaymentAttemptSchema),...errors({...ownerErrors,400:'bad_request / invalid_json: invalid parameters or scenario; delayMs requires delayed_success',
     409:'hold_not_active / payment_in_progress / already_confirmed / idempotency_key_reused / idempotency_in_progress',
     413:'payload_too_large: decoded body exceeds 16 KB',415:'unsupported_media_type: unsupported encoding or charset'})}});
 registry.registerPath({method:'post',path:'/payments/notifications',security:[{PaymentSignature:[]}],
   request:{headers:z.object({'x-seatrush-signature':z.string().regex(/^[0-9a-f]{64}$/)}),body:{required:true,content:{'application/json':{schema:PaymentNotificationSchema}}}},
   responses:{200:response(PaymentNotificationResultSchema),...errors({
     400:'bad_request / invalid_json: invalid notification schema or JSON',401:'invalid_signature: missing, malformed or incorrect HMAC',
     404:'not_found: unknown payment attempt (including attempts removed by reset)',
     409:'idempotency_key_reused: providerEventId reused with different paymentAttemptId or outcome',
     413:'payload_too_large: decoded body exceeds 16 KB',415:'unsupported_media_type: application/json required; unsupported encoding or charset',
     503:'retry_later: database unavailable or bounded conflict retry exhausted'})}});
 registry.registerPath({method:'get',path:'/payments/{paymentAttemptId}',security:[{CustomerBearer:[]}],request:{params:PaymentParamsSchema},
   responses:{200:response(PaymentAttemptSchema),...errors(ownerErrors)}});
 registry.registerPath({method:'get',path:'/bookings/{bookingId}',security:[{CustomerBearer:[]}],request:{params:BookingParamsSchema},
   responses:{200:response(BookingSchema),...errors(ownerErrors)}});
}
