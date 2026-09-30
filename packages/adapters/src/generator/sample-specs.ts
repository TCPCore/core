import type { SpecFormat } from '@tcpcore1/shared';

/**
 * Bundled sample specs for the Adapter Generator Studio.
 *
 * These exist so a developer can see the whole pipeline — spec in, governed
 * adapter out — without having an OpenAPI document to hand. Each one is chosen
 * to demonstrate a different part of the risk model:
 *
 *  - `petstore`     — a plain CRUD API (low / medium / high)
 *  - `payments`     — money movement, triggers the conditional-risk hint
 *  - `inbox`        — free-text responses, triggers content_risk detection
 *  - `infra`        — destructive infrastructure verbs, triggers agent_forbidden
 *  - `swagger2`     — the Swagger 2.0 conversion path
 */

export interface SampleSpec {
  id: string;
  name: string;
  description: string;
  format: SpecFormat;
  content: string;
  /** Suggested base URL override; `undefined` uses the spec's own server. */
  defaultBaseUrl?: string;
}

const PETSTORE = `openapi: 3.0.3
info:
  title: Petstore
  version: 1.0.0
  description: A small inventory API, used to show the low/medium/high split.
servers:
  - url: https://petstore.example.com/api/v3
paths:
  /pets:
    get:
      operationId: listPets
      summary: List pets, optionally filtered by status
      tags: [pets]
      parameters:
        - name: status
          in: query
          required: false
          schema:
            type: string
            enum: [available, pending, sold]
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
      responses:
        '200':
          description: A list of pets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Pet'
    post:
      operationId: createPet
      summary: Add a new pet to the store
      tags: [pets]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/NewPet'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        required: true
        description: Identifier of the pet
        schema:
          type: string
    get:
      operationId: getPetById
      summary: Retrieve a single pet by id
      tags: [pets]
      responses:
        '200':
          description: A pet
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
    patch:
      operationId: updatePet
      summary: Update a pet's name or status
      tags: [pets]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                status:
                  type: string
                  enum: [available, pending, sold]
      responses:
        '200':
          description: Updated
    delete:
      operationId: deletePet
      summary: Remove a pet from the store
      tags: [pets]
      responses:
        '204':
          description: Deleted
  /pets/{petId}/photo:
    post:
      operationId: uploadPetPhoto
      summary: Upload a photo for a pet
      tags: [media]
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                caption:
                  type: string
      responses:
        '200':
          description: Uploaded
components:
  schemas:
    Pet:
      type: object
      required: [id, name, status]
      properties:
        id:
          type: string
        name:
          type: string
        status:
          type: string
          enum: [available, pending, sold]
        tags:
          type: array
          items:
            type: string
    NewPet:
      type: object
      required: [name]
      properties:
        name:
          type: string
        status:
          type: string
          enum: [available, pending, sold]
        photoUrls:
          type: array
          items:
            type: string
            format: uri
`;

const PAYMENTS = `openapi: 3.0.3
info:
  title: Payments Gateway
  version: 2.1.0
  description: Money movement. Demonstrates high-risk inference and the conditional-risk hint.
servers:
  - url: https://api.payments.example.com/v1
security:
  - bearerAuth: []
paths:
  /charges/{chargeId}:
    get:
      operationId: getCharge
      summary: Retrieve a charge
      tags: [charges]
      parameters:
        - name: chargeId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: A charge
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  amount: { type: integer }
                  currency: { type: string }
                  status: { type: string }
  /refunds:
    post:
      operationId: createRefund
      summary: Refund a charge, in full or in part
      tags: [refunds]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [chargeId, amount]
              properties:
                chargeId:
                  type: string
                amount:
                  type: integer
                  minimum: 1
                  description: Amount in the smallest currency unit
                reason:
                  type: string
                  enum: [duplicate, fraudulent, requested_by_customer]
      responses:
        '201':
          description: Refund created
  /payouts:
    post:
      operationId: createPayout
      summary: Send funds to a connected bank account
      tags: [payouts]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [accountId, amount]
              properties:
                accountId:
                  type: string
                amount:
                  type: number
      responses:
        '201':
          description: Payout scheduled
  /customers/{customerId}:
    delete:
      operationId: deleteCustomer
      summary: Erase a customer and their billing history
      tags: [customers]
      parameters:
        - name: customerId
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Deleted
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;

const INBOX = `openapi: 3.0.3
info:
  title: Support Inbox
  version: 1.4.0
  description: Free-text responses. Demonstrates content_risk detection for prompt-injection defence.
servers:
  - url: https://inbox.example.com/api
paths:
  /conversations:
    get:
      operationId: listConversations
      summary: List open conversations
      tags: [conversations]
      responses:
        '200':
          description: Conversations
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id: { type: string }
                    subject: { type: string }
                    body:
                      type: string
                      description: The customer's original message
                    internal_notes:
                      type: string
  /conversations/{conversationId}:
    parameters:
      - name: conversationId
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getConversation
      summary: Read a conversation with its full message thread
      tags: [conversations]
      responses:
        '200':
          description: A conversation
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  messages:
                    type: array
                    items:
                      type: object
                      properties:
                        author: { type: string }
                        text: { type: string }
  /conversations/{conversationId}/reply:
    post:
      operationId: replyToConversation
      summary: Send a reply to the customer
      tags: [conversations]
      parameters:
        - name: conversationId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [body]
              properties:
                body: { type: string }
      responses:
        '201':
          description: Reply sent
  /conversations/{conversationId}/close:
    post:
      operationId: closeConversation
      summary: Close the conversation and stop the SLA clock
      tags: [conversations]
      parameters:
        - name: conversationId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Closed
`;

const INFRA = `openapi: 3.0.3
info:
  title: Cluster Control
  version: 3.0.0
  description: Destructive infrastructure verbs. Demonstrates agent_forbidden inference.
servers:
  - url: https://control.example.com/v1
paths:
  /clusters:
    get:
      operationId: listClusters
      summary: List clusters
      tags: [clusters]
      responses:
        '200':
          description: Clusters
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id: { type: string }
                    region: { type: string }
                    nodeCount: { type: integer }
    post:
      operationId: createCluster
      summary: Provision a new cluster
      tags: [clusters]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [region, nodeCount]
              properties:
                region: { type: string }
                nodeCount: { type: integer, minimum: 1, maximum: 100 }
      responses:
        '202':
          description: Provisioning
  /clusters/{clusterId}/scale:
    post:
      operationId: scaleCluster
      summary: Change the node count of a cluster
      tags: [clusters]
      parameters:
        - name: clusterId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [nodeCount]
              properties:
                nodeCount: { type: integer, minimum: 1, maximum: 100 }
      responses:
        '202':
          description: Scaling
  /clusters/{clusterId}:
    delete:
      operationId: destroyCluster
      summary: Permanently destroy a cluster and all its volumes
      tags: [clusters]
      parameters:
        - name: clusterId
          in: path
          required: true
          schema:
            type: string
      responses:
        '202':
          description: Destroying
  /clusters/{clusterId}/nodes/{nodeId}:
    delete:
      operationId: terminateNode
      summary: Terminate a single node
      tags: [clusters]
      parameters:
        - name: clusterId
          in: path
          required: true
          schema:
            type: string
        - name: nodeId
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Terminated
  /api-keys/{keyId}:
    delete:
      operationId: revokeApiKey
      summary: Revoke an API key immediately
      tags: [security]
      parameters:
        - name: keyId
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Revoked
`;

const SWAGGER2 = `swagger: '2.0'
info:
  title: Legacy CRM
  version: 1.0.0
  description: A Swagger 2.0 document, to exercise the conversion path.
host: legacy-crm.example.com
basePath: /api/v2
schemes: [https]
securityDefinitions:
  apiKey:
    type: apiKey
    name: X-Api-Key
    in: header
paths:
  /contacts:
    get:
      operationId: listContacts
      summary: List contacts
      parameters:
        - name: company
          in: query
          type: string
        - name: limit
          in: query
          type: integer
      responses:
        '200':
          description: Contacts
          schema:
            type: array
            items:
              $ref: '#/definitions/Contact'
    post:
      operationId: createContact
      summary: Create a contact
      parameters:
        - name: body
          in: body
          required: true
          schema:
            $ref: '#/definitions/NewContact'
      responses:
        '201':
          description: Created
          schema:
            $ref: '#/definitions/Contact'
  /contacts/{contactId}:
    get:
      operationId: getContact
      summary: Retrieve a contact
      parameters:
        - name: contactId
          in: path
          required: true
          type: string
      responses:
        '200':
          description: A contact
          schema:
            $ref: '#/definitions/Contact'
    delete:
      operationId: deleteContact
      summary: Delete a contact
      parameters:
        - name: contactId
          in: path
          required: true
          type: string
      responses:
        '204':
          description: Deleted
definitions:
  Contact:
    type: object
    properties:
      id:
        type: string
      fullName:
        type: string
      notes:
        type: string
      company:
        type: string
  NewContact:
    type: object
    required: [fullName]
    properties:
      fullName:
        type: string
      company:
        type: string
      notes:
        type: string
`;

export const SAMPLE_SPECS: SampleSpec[] = [
  {
    id: 'petstore',
    name: 'Petstore (OpenAPI 3.0)',
    description:
      'A small inventory API. Produces low-risk reads, a medium-risk write and a high-risk delete.',
    format: 'openapi',
    content: PETSTORE,
  },
  {
    id: 'payments',
    name: 'Payments Gateway (money movement)',
    description:
      'Refunds and payouts. Shows high-risk inference for money movement and the conditional-risk hint for amount fields.',
    format: 'openapi',
    content: PAYMENTS,
  },
  {
    id: 'inbox',
    name: 'Support Inbox (free-text responses)',
    description:
      'Conversation and message bodies. Shows content_risk detection, which drives prompt-injection scanning.',
    format: 'openapi',
    content: INBOX,
  },
  {
    id: 'infra',
    name: 'Cluster Control (destructive verbs)',
    description:
      'Destroy, terminate and revoke operations. Shows agent_forbidden inference for irreversible actions.',
    format: 'openapi',
    content: INFRA,
  },
  {
    id: 'swagger2',
    name: 'Legacy CRM (Swagger 2.0)',
    description: 'Exercises the Swagger 2.0 to OpenAPI 3 conversion and body-parameter handling.',
    format: 'swagger',
    content: SWAGGER2,
  },
];

export function getSampleSpec(id: string): SampleSpec | undefined {
  return SAMPLE_SPECS.find((spec) => spec.id === id);
}
